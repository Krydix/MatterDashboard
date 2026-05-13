#include "matter_runtime.hpp"
#include "mini_json.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#if defined(__APPLE__) || defined(__linux__)
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#endif

using mkjson::JsonValue;
namespace fs = std::filesystem;

namespace {

struct PendingResponse {
  std::mutex mutex;
  std::condition_variable cv;
  bool ready = false;
  bool ok = false;
  JsonValue result;
  std::string error;
};

struct ChildProcess {
#if defined(__APPLE__) || defined(__linux__)
  pid_t pid = -1;
#endif

  [[nodiscard]] bool running() const {
#if defined(__APPLE__) || defined(__linux__)
    return pid > 0;
#else
    return false;
#endif
  }
};

[[nodiscard]] std::string getenv_or_empty(const char *name) {
  const char *value = std::getenv(name);
  return value == nullptr ? std::string() : std::string(value);
}

[[nodiscard]] std::string require_string(const JsonValue &value, std::string_view key) {
  const JsonValue *field = value.find(key);
  if (field == nullptr || !field->is_string()) {
    throw std::runtime_error("Missing string field: " + std::string(key));
  }
  return field->as_string();
}

[[nodiscard]] bool bool_or(const JsonValue &value, std::string_view key, bool fallback) {
  const JsonValue *field = value.find(key);
  if (field == nullptr || !field->is_bool()) {
    return fallback;
  }
  return field->as_bool();
}

[[nodiscard]] int int_or(const JsonValue &value, std::string_view key, int fallback) {
  const JsonValue *field = value.find(key);
  if (field == nullptr || !field->is_number()) {
    return fallback;
  }
  return static_cast<int>(field->as_number());
}

[[nodiscard]] fs::path current_executable_path() {
#ifdef __APPLE__
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::string buffer(size, '\0');
  if (_NSGetExecutablePath(buffer.data(), &size) != 0) {
    throw std::runtime_error("Failed to resolve executable path");
  }
  return fs::weakly_canonical(fs::path(buffer.c_str()));
#elif defined(__linux__)
  std::vector<char> buffer(4096);
  const auto size = ::readlink("/proc/self/exe", buffer.data(), buffer.size() - 1);
  if (size <= 0) {
    throw std::runtime_error("Failed to resolve executable path");
  }
  buffer[static_cast<std::size_t>(size)] = '\0';
  return fs::weakly_canonical(fs::path(buffer.data()));
#else
  return fs::current_path();
#endif
}

[[nodiscard]] std::string host_bundle_name() {
#if defined(__APPLE__)
  const char *platform = "darwin";
#elif defined(_WIN32)
  const char *platform = "win32";
#else
  const char *platform = "linux";
#endif

#if defined(__aarch64__) || defined(__arm64__) || defined(_M_ARM64)
  const char *arch = "arm64";
#elif defined(__x86_64__) || defined(_M_X64)
  const char *arch = "x64";
#else
  const char *arch = "unknown";
#endif

  return std::string(platform) + "-" + arch;
}

[[nodiscard]] std::string accessory_kind_to_json(MatterAccessoryKind kind) {
  switch (kind) {
    case MatterAccessoryKind::Dashboard:
      return "dashboard";
    case MatterAccessoryKind::Volume:
      return "volume";
    case MatterAccessoryKind::Brightness:
      return "brightness";
  }

  return "dashboard";
}

[[nodiscard]] std::string accessory_device_type_to_json(MatterAccessoryDeviceType deviceType) {
  switch (deviceType) {
    case MatterAccessoryDeviceType::OnOffPlugInUnit:
      return "on-off-plug-in-unit";
    case MatterAccessoryDeviceType::DimmableLight:
      return "dimmable-light";
  }

  return "on-off-plug-in-unit";
}

[[nodiscard]] JsonValue accessories_to_json(const std::vector<MatterAccessory> &targets) {
  JsonValue::Array array;
  array.reserve(targets.size());

  for (const auto &target : targets) {
    array.emplace_back(JsonValue::Object{{"id", target.id},
                                         {"name", target.name},
                                         {"kind", accessory_kind_to_json(target.kind)},
                                         {"deviceType", accessory_device_type_to_json(target.deviceType)},
                                         {"url", target.url},
                                         {"durationSeconds", target.durationSeconds},
                                         {"enabled", target.enabled},
                                         {"on", target.on},
                                         {"level", static_cast<int>(target.level)}});
  }

  return JsonValue(std::move(array));
}

[[nodiscard]] JsonValue accessory_to_json(const MatterAccessory &target) {
  return JsonValue::Object{{"id", target.id},
                           {"name", target.name},
                           {"kind", accessory_kind_to_json(target.kind)},
                           {"deviceType", accessory_device_type_to_json(target.deviceType)},
                           {"url", target.url},
                           {"durationSeconds", target.durationSeconds},
                           {"enabled", target.enabled},
                           {"on", target.on},
                           {"level", static_cast<int>(target.level)}};
}

[[nodiscard]] MatterStatus status_from_json(const JsonValue &value) {
  MatterStatus status;
  if (!value.is_object()) {
    return status;
  }

  status.started = bool_or(value, "started", false);
  status.paired = bool_or(value, "paired", false);

  if (const JsonValue *field = value.find("qrCode"); field != nullptr && field->is_string()) {
    status.qrCode = field->as_string();
  }

  if (const JsonValue *field = value.find("manualPairingCode"); field != nullptr && field->is_string()) {
    status.manualPairingCode = field->as_string();
  }

  return status;
}

#if defined(__APPLE__) || defined(__linux__)
void write_all(int fd, const std::string &text) {
  std::size_t offset = 0;
  while (offset < text.size()) {
    const auto written = ::write(fd, text.data() + offset, text.size() - offset);
    if (written < 0) {
      if (errno == EINTR) {
        continue;
      }
      throw std::runtime_error("Failed to write to FIFO");
    }
    offset += static_cast<std::size_t>(written);
  }
}

[[nodiscard]] bool read_line(int fd, std::string &line) {
  line.clear();
  char character = 0;

  while (true) {
    const auto bytesRead = ::read(fd, &character, 1);
    if (bytesRead == 0) {
      return !line.empty();
    }
    if (bytesRead < 0) {
      if (errno == EINTR) {
        continue;
      }
      return false;
    }
    if (character == '\n') {
      return true;
    }
    line.push_back(character);
  }
}

ChildProcess spawn_child_process(const fs::path &executable,
                                 const std::vector<std::string> &args,
                                 const std::map<std::string, std::string> &envOverrides) {
  const pid_t pid = ::fork();
  if (pid < 0) {
    throw std::runtime_error("Failed to fork child process");
  }

  if (pid == 0) {
    for (const auto &[key, value] : envOverrides) {
      if (value.empty()) {
        ::unsetenv(key.c_str());
      } else {
        ::setenv(key.c_str(), value.c_str(), 1);
      }
    }

    std::vector<char *> argv;
    argv.reserve(args.size() + 2);
    argv.push_back(const_cast<char *>(executable.c_str()));
    for (const auto &arg : args) {
      argv.push_back(const_cast<char *>(arg.c_str()));
    }
    argv.push_back(nullptr);

    ::execve(executable.c_str(), argv.data(), environ);
    std::_Exit(127);
  }

  return ChildProcess{pid};
}

void terminate_process(const ChildProcess &process) {
  if (process.pid > 0) {
    ::kill(process.pid, SIGTERM);
  }
}

void cleanup_orphaned_bridge_processes(const fs::path &binaryPath) {
  FILE *processList = ::popen("ps -axo pid=,ppid=,command=", "r");
  if (processList == nullptr) {
    return;
  }

  const std::string binary = binaryPath.string();
  const std::string binaryName = binaryPath.filename().string();
  char line[4096];

  while (std::fgets(line, sizeof(line), processList) != nullptr) {
    std::istringstream stream(line);
    pid_t pid = -1;
    pid_t ppid = -1;
    if (!(stream >> pid >> ppid)) {
      continue;
    }

    std::string command;
    std::getline(stream, command);
    const bool exactBinaryMatch = command.find(binary) != std::string::npos;
    const bool sameBridgeName = command.find(binaryName) != std::string::npos;
    if (ppid != 1 || (!exactBinaryMatch && !sameBridgeName)) {
      continue;
    }

    ::kill(pid, SIGTERM);
    for (int attempt = 0; attempt < 20; ++attempt) {
      if (::kill(pid, 0) != 0 && errno == ESRCH) {
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    if (::kill(pid, 0) == 0 || errno != ESRCH) {
      ::kill(pid, SIGKILL);
      for (int attempt = 0; attempt < 20; ++attempt) {
        if (::kill(pid, 0) != 0 && errno == ESRCH) {
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
      }
    }
  }

  ::pclose(processList);
}

[[nodiscard]] int open_fifo_for_write(const fs::path &path, std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;

  while (true) {
    const int fd = ::open(path.c_str(), O_WRONLY | O_NONBLOCK);
    if (fd >= 0) {
      return fd;
    }

    if (errno != ENXIO && errno != ENOENT) {
      throw std::runtime_error("Failed to open request FIFO");
    }

    if (std::chrono::steady_clock::now() >= deadline) {
      throw std::runtime_error("Timed out waiting for CHIP bridge request FIFO reader");
    }

    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
}

void write_fifo_message(const fs::path &path, const std::string &message, std::chrono::milliseconds timeout) {
  const int fd = open_fifo_for_write(path, timeout);
  write_all(fd, message);
  ::close(fd);
}
#endif

class MatterChipProcessRuntime final : public MatterRuntime {
 public:
  explicit MatterChipProcessRuntime(std::string storagePath)
      : storagePath_(std::move(storagePath)),
        kvsPath_(fs::path(storagePath_) / "chip-kvs"),
        requestPipePath_(fs::path(storagePath_) / "bridge-requests.fifo"),
        responsePipePath_(fs::path(storagePath_) / "bridge-responses.fifo") {}

  ~MatterChipProcessRuntime() override { shutdown(); }

  void setAccessoryTurnedOnHandler(EventHandler handler) override { onAccessoryTurnedOn_ = std::move(handler); }
  void setAccessoryTurnedOffHandler(EventHandler handler) override { onAccessoryTurnedOff_ = std::move(handler); }
  void setAccessoryLevelChangedHandler(LevelChangedHandler handler) override { onAccessoryLevelChanged_ = std::move(handler); }

  MatterStatus start(const std::vector<MatterAccessory> &targets) override {
    lastTargets_ = targets;
    ensure_bridge_started();
    status_ = send_status_request(JsonValue::Object{{"type", "sync-targets"}, {"targets", accessories_to_json(targets)}});
    return status_;
  }

  MatterStatus syncAccessories(const std::vector<MatterAccessory> &targets) override {
    lastTargets_ = targets;
    ensure_bridge_started();
    status_ = send_status_request(JsonValue::Object{{"type", "sync-targets"}, {"targets", accessories_to_json(targets)}});
    return status_;
  }

  void setAccessoryState(const MatterAccessory &accessory) override {
    if (!child_.running()) {
      return;
    }

    send_command(JsonValue::Object{{"type", "set-target-state"}, {"target", accessory_to_json(accessory)}});
  }

  MatterStatus getStatus() override {
    if (!child_.running()) {
      return status_;
    }
    status_ = send_status_request(JsonValue::Object{{"type", "get-status"}});
    return status_;
  }

  MatterStatus reset() override {
    shutdown();

    std::error_code error;
    fs::remove_all(storagePath_, error);
    fs::create_directories(storagePath_, error);
    if (error) {
      throw std::runtime_error("Failed to reset CHIP runtime storage");
    }

    status_ = {};
    return start(lastTargets_);
  }

  void setAccessoryOff(const std::string &targetId) override {
    if (!child_.running()) {
      return;
    }
    send_command(JsonValue::Object{{"type", "set-target-off"}, {"targetId", targetId}});
  }

  void stop() override {
    shutdown();
    status_ = {};
  }

 private:
  void ensure_bridge_started() {
    if (child_.running()) {
      return;
    }

    const fs::path bridgeBinaryPath = chip_bridge_binary_path();

    std::error_code error;
    fs::create_directories(storagePath_, error);
    if (error) {
      throw std::runtime_error("Failed to create CHIP runtime storage directory");
    }

    fs::remove(requestPipePath_, error);
    error.clear();
    fs::remove(responsePipePath_, error);

#if defined(__APPLE__) || defined(__linux__)
    stopReader_ = false;
    cleanup_orphaned_bridge_processes(bridgeBinaryPath);
    try {
      child_ = spawn_child_process(bridgeBinaryPath,
                                   {"--KVS",
                                    kvsPath_.string(),
                                    "--app-pipe",
                                    requestPipePath_.string(),
                                    "--app-pipe-out",
                                    responsePipePath_.string()},
                                   chip_bridge_environment());
      wait_for_fifo(requestPipePath_);
      wait_for_fifo(responsePipePath_);
      readerThread_ = std::thread([this]() { read_bridge_output(); });
    } catch (...) {
      shutdown();
      throw;
    }
#else
    throw std::runtime_error("Native CHIP runtime is only implemented on Unix-like hosts in this revision.");
#endif
  }

  MatterStatus send_status_request(const JsonValue &payload) {
    const JsonValue result = send_command(payload);
    status_ = status_from_json(result);
    return status_;
  }

  JsonValue send_command(JsonValue payload) {
    const int requestId = nextRequestId_.fetch_add(1);
    payload.as_object()["requestId"] = requestId;

    auto pending = std::make_shared<PendingResponse>();
    {
      std::lock_guard<std::mutex> lock(pendingMutex_);
      pendingRequests_.emplace(requestId, pending);
    }

#if defined(__APPLE__) || defined(__linux__)
    try {
      write_fifo_message(requestPipePath_, mkjson::stringify(payload) + "\n", std::chrono::seconds(5));
    } catch (...) {
      std::lock_guard<std::mutex> lock(pendingMutex_);
      pendingRequests_.erase(requestId);
      throw;
    }
#endif

    std::unique_lock<std::mutex> lock(pending->mutex);
    if (!pending->cv.wait_for(lock, std::chrono::seconds(10), [&pending] { return pending->ready; })) {
      throw std::runtime_error("Timed out waiting for CHIP bridge response");
    }

    if (!pending->ok) {
      throw std::runtime_error(pending->error.empty() ? "CHIP bridge request failed" : pending->error);
    }

    return pending->result;
  }

  void read_bridge_output() {
#if defined(__APPLE__) || defined(__linux__)
    while (!stopReader_) {
      const int fd = ::open(responsePipePath_.c_str(), O_RDONLY);
      if (fd < 0) {
        if (stopReader_) {
          break;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        continue;
      }

      std::string line;
      while (!stopReader_ && read_line(fd, line)) {
        if (!line.empty()) {
          handle_bridge_message(line);
        }
      }

      ::close(fd);
    }
#endif

    fail_pending_requests("CHIP bridge stopped");
  }

  void handle_bridge_message(const std::string &line) {
    const JsonValue message = mkjson::parse(line);
    const std::string type = require_string(message, "type");

    if (type == "response") {
      const int requestId = int_or(message, "requestId", -1);
      std::shared_ptr<PendingResponse> pending;
      {
        std::lock_guard<std::mutex> lock(pendingMutex_);
        const auto it = pendingRequests_.find(requestId);
        if (it == pendingRequests_.end()) {
          return;
        }
        pending = it->second;
        pendingRequests_.erase(it);
      }

      {
        std::lock_guard<std::mutex> lock(pending->mutex);
        pending->ready = true;
        pending->ok = bool_or(message, "ok", false);
        if (const JsonValue *result = message.find("result"); result != nullptr) {
          pending->result = *result;
        }
        if (const JsonValue *error = message.find("error"); error != nullptr && error->is_string()) {
          pending->error = error->as_string();
        }
      }
      pending->cv.notify_all();
      return;
    }

    if (type == "target-triggered" && onAccessoryTurnedOn_) {
      onAccessoryTurnedOn_(require_string(message, "targetId"));
      return;
    }

    if (type == "target-turned-off" && onAccessoryTurnedOff_) {
      onAccessoryTurnedOff_(require_string(message, "targetId"));
      return;
    }

    if (type == "target-level-changed" && onAccessoryLevelChanged_) {
      onAccessoryLevelChanged_(require_string(message, "targetId"), static_cast<std::uint8_t>(int_or(message, "level", 0)));
    }
  }

  void fail_pending_requests(const std::string &message) {
    std::unordered_map<int, std::shared_ptr<PendingResponse>> pending;
    {
      std::lock_guard<std::mutex> lock(pendingMutex_);
      pending.swap(pendingRequests_);
    }

    for (const auto &[requestId, entry] : pending) {
      (void)requestId;
      std::lock_guard<std::mutex> lock(entry->mutex);
      entry->ready = true;
      entry->ok = false;
      entry->error = message;
      entry->cv.notify_all();
    }
  }

  void shutdown() {
    stopReader_ = true;

#if defined(__APPLE__) || defined(__linux__)
    std::error_code error;
    if (fs::exists(responsePipePath_)) {
      try {
        write_fifo_message(responsePipePath_, "\n", std::chrono::milliseconds(100));
      } catch (...) {
      }
    }

    if (child_.running()) {
      terminate_process(child_);
      ::waitpid(child_.pid, nullptr, 0);
      child_.pid = -1;
    }

    fs::remove(requestPipePath_, error);
    error.clear();
    fs::remove(responsePipePath_, error);
#endif

    if (readerThread_.joinable()) {
      readerThread_.join();
    }

    fail_pending_requests("CHIP bridge stopped");
  }

  void wait_for_fifo(const fs::path &path) const {
    for (int attempt = 0; attempt < 100; ++attempt) {
      std::error_code error;
      if (fs::exists(path, error) && !error) {
        return;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    throw std::runtime_error("Timed out waiting for CHIP bridge FIFO: " + path.string());
  }

  [[nodiscard]] fs::path resource_root_path() const {
    const std::string envRoot = getenv_or_empty("MATTERKIOSK_RESOURCE_ROOT");
    if (!envRoot.empty()) {
      return envRoot;
    }

    const fs::path executable = current_executable_path();
    const fs::path maybeResources = executable.parent_path().parent_path().parent_path();
    if (fs::exists(maybeResources / "app.asar")) {
      return maybeResources;
    }
    return {};
  }

  [[nodiscard]] fs::path chip_bridge_binary_path() const {
    const std::string explicitPath = getenv_or_empty("MATTERKIOSK_CHIP_BRIDGE_BINARY");
    if (!explicitPath.empty()) {
      return explicitPath;
    }

    const fs::path resourceRoot = resource_root_path();
    if (!resourceRoot.empty()) {
      return resourceRoot / "native" / host_bundle_name() /
#if defined(_WIN32)
          "chip-bridge-app.exe";
#else
          "chip-bridge-app";
#endif
    }

    fs::path candidate = current_executable_path();
    for (int i = 0; i < 5; ++i) {
      candidate = candidate.parent_path();
    }
    candidate /= "assets";
    candidate /= "native";
    candidate /= host_bundle_name();
    candidate /=
#if defined(_WIN32)
        "chip-bridge-app.exe";
#else
        "chip-bridge-app";
#endif

    return candidate;
  }

  [[nodiscard]] std::map<std::string, std::string> chip_bridge_environment() const {
    return {};
  }

  std::string storagePath_;
  fs::path kvsPath_;
  fs::path requestPipePath_;
  fs::path responsePipePath_;
  std::vector<MatterAccessory> lastTargets_;
  ChildProcess child_;
  std::thread readerThread_;
  std::atomic<bool> stopReader_{false};
  MatterStatus status_;
  std::atomic<int> nextRequestId_{1};
  std::mutex pendingMutex_;
  std::unordered_map<int, std::shared_ptr<PendingResponse>> pendingRequests_;
  EventHandler onAccessoryTurnedOn_;
  EventHandler onAccessoryTurnedOff_;
  LevelChangedHandler onAccessoryLevelChanged_;
};

}  // namespace

std::unique_ptr<MatterRuntime> create_chip_process_matter_runtime(std::string storagePath) {
  return std::make_unique<MatterChipProcessRuntime>(std::move(storagePath));
}