#include "matter_runtime.hpp"
#include "mini_json.hpp"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
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
#include <fcntl.h>
#include <signal.h>
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
  int stdinFd = -1;
  int stdoutFd = -1;
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

[[nodiscard]] std::string accessory_kind_to_json(MatterAccessoryKind kind) {
  switch (kind) {
    case MatterAccessoryKind::Dashboard:
      return "dashboard";
    case MatterAccessoryKind::Volume:
      return "volume";
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
    array.emplace_back(JsonValue::Object{
      {"id", target.id},
      {"name", target.name},
      {"kind", accessory_kind_to_json(target.kind)},
      {"deviceType", accessory_device_type_to_json(target.deviceType)},
      {"url", target.url},
      {"durationSeconds", target.durationSeconds},
      {"enabled", target.enabled},
      {"on", target.on},
      {"level", static_cast<int>(target.level)},
    });
  }

  return JsonValue(std::move(array));
}

[[nodiscard]] JsonValue accessory_to_json(const MatterAccessory &target) {
  return JsonValue::Object{
    {"id", target.id},
    {"name", target.name},
    {"kind", accessory_kind_to_json(target.kind)},
    {"deviceType", accessory_device_type_to_json(target.deviceType)},
    {"url", target.url},
    {"durationSeconds", target.durationSeconds},
    {"enabled", target.enabled},
    {"on", target.on},
    {"level", static_cast<int>(target.level)},
  };
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
void close_fd(int &fd) {
  if (fd >= 0) {
    ::close(fd);
    fd = -1;
  }
}

void write_all(int fd, const std::string &text) {
  std::size_t offset = 0;
  while (offset < text.size()) {
    const auto written = ::write(fd, text.data() + offset, text.size() - offset);
    if (written < 0) {
      if (errno == EINTR) {
        continue;
      }
      throw std::runtime_error("Failed to write to child process");
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

[[nodiscard]] std::string_view trim_ascii(std::string_view text) {
  while (!text.empty() && (text.front() == ' ' || text.front() == '\t' || text.front() == '\r' || text.front() == '\n')) {
    text.remove_prefix(1);
  }

  while (!text.empty() && (text.back() == ' ' || text.back() == '\t' || text.back() == '\r' || text.back() == '\n')) {
    text.remove_suffix(1);
  }

  return text;
}

[[nodiscard]] std::optional<std::string> extract_protocol_json(std::string_view line) {
  constexpr std::string_view kProtocolPrefix = "MKP:";

  line = trim_ascii(line);
  const std::size_t prefixOffset = line.find(kProtocolPrefix);
  if (prefixOffset != std::string_view::npos) {
    line.remove_prefix(prefixOffset + kProtocolPrefix.size());
  } else if (line.empty() || line.front() != '{') {
    return std::nullopt;
  }

  line = trim_ascii(line);
  if (line.empty() || line.front() != '{') {
    return std::nullopt;
  }

  bool inString = false;
  bool escaping = false;
  int depth = 0;

  for (std::size_t index = 0; index < line.size(); ++index) {
    const char ch = line[index];

    if (escaping) {
      escaping = false;
      continue;
    }

    if (ch == '\\' && inString) {
      escaping = true;
      continue;
    }

    if (ch == '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch == '{') {
      ++depth;
      continue;
    }

    if (ch != '}') {
      continue;
    }

    --depth;
    if (depth == 0) {
      return std::string(line.substr(0, index + 1));
    }
  }

  return std::nullopt;
}

ChildProcess spawn_child_with_stdio(const fs::path &executable,
                                    const std::vector<std::string> &args,
                                    const std::map<std::string, std::string> &envOverrides) {
  int stdinPipe[2];
  int stdoutPipe[2];
  if (::pipe(stdinPipe) != 0 || ::pipe(stdoutPipe) != 0) {
    throw std::runtime_error("Failed to create pipes for child process");
  }

  const pid_t pid = ::fork();
  if (pid < 0) {
    throw std::runtime_error("Failed to fork child process");
  }

  if (pid == 0) {
    ::dup2(stdinPipe[0], STDIN_FILENO);
    ::dup2(stdoutPipe[1], STDOUT_FILENO);
    ::close(stdinPipe[0]);
    ::close(stdinPipe[1]);
    ::close(stdoutPipe[0]);
    ::close(stdoutPipe[1]);

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
    std::perror("execve");
    std::_Exit(127);
  }

  ::close(stdinPipe[0]);
  ::close(stdoutPipe[1]);

  return ChildProcess{pid, stdinPipe[1], stdoutPipe[0]};
}

void terminate_process(const ChildProcess &process) {
  if (process.pid > 0) {
    ::kill(process.pid, SIGTERM);
  }
}
#endif

class MatterWorkerRuntime final : public MatterRuntime {
 public:
  explicit MatterWorkerRuntime(std::string storagePath)
      : storagePath_(std::move(storagePath)) {}

  ~MatterWorkerRuntime() override { shutdown(); }

  void setAccessoryTurnedOnHandler(EventHandler handler) override { onAccessoryTurnedOn_ = std::move(handler); }
  void setAccessoryTurnedOffHandler(EventHandler handler) override { onAccessoryTurnedOff_ = std::move(handler); }
  void setAccessoryLevelChangedHandler(LevelChangedHandler handler) override { onAccessoryLevelChanged_ = std::move(handler); }

  MatterStatus start(const std::vector<MatterAccessory> &targets) override {
    ensure_worker_started();
    return send_status_request(JsonValue::Object{
      {"type", "start"},
      {"storagePath", storagePath_},
      {"targets", accessories_to_json(targets)},
    });
  }

  MatterStatus syncAccessories(const std::vector<MatterAccessory> &targets) override {
    if (!child_.running()) {
      return start(targets);
    }
    return send_status_request(JsonValue::Object{
      {"type", "sync-targets"},
      {"targets", accessories_to_json(targets)},
    });
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
    if (!child_.running()) {
      return status_;
    }
    status_ = send_status_request(JsonValue::Object{{"type", "reset"}});
    return status_;
  }

  void setAccessoryOff(const std::string &targetId) override {
    if (!child_.running()) {
      return;
    }
    send_command(JsonValue::Object{{"type", "set-target-off"}, {"targetId", targetId}});
  }

  void stop() override {
    if (!child_.running()) {
      return;
    }
    try {
      send_command(JsonValue::Object{{"type", "stop"}});
    } catch (...) {
    }
    shutdown();
    status_ = {};
  }

 private:
  void ensure_worker_started() {
    if (child_.running()) {
      return;
    }

#if defined(__APPLE__) || defined(__linux__)
    child_ = spawn_child_with_stdio(worker_executable_path(), {worker_script_path().string()}, worker_environment());
    readerThread_ = std::thread([this]() { read_worker_output(); });
#else
    throw std::runtime_error("Native Matter daemon is only implemented on Unix-like hosts in this revision.");
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
    write_all(child_.stdinFd, mkjson::stringify(payload) + "\n");
#endif

    std::unique_lock<std::mutex> lock(pending->mutex);
    if (!pending->cv.wait_for(lock, std::chrono::seconds(10), [&pending] { return pending->ready; })) {
      throw std::runtime_error("Timed out waiting for Matter worker response");
    }

    if (!pending->ok) {
      throw std::runtime_error(pending->error.empty() ? "Matter worker request failed" : pending->error);
    }

    return pending->result;
  }

  void read_worker_output() {
#if defined(__APPLE__) || defined(__linux__)
    std::string line;
    while (read_line(child_.stdoutFd, line)) {
      if (!line.empty()) {
        try {
          handle_worker_message(line);
        } catch (const std::exception &error) {
          std::cerr << "[matterkiosk-daemon] Ignoring malformed worker stdout line: " << error.what() << '\n';
        }
      }
    }
#endif

    fail_pending_requests("Matter worker exited");
  }

  void handle_worker_message(const std::string &line) {
    const auto payload = extract_protocol_json(line);
    if (!payload.has_value()) {
      return;
    }

    const JsonValue message = mkjson::parse(*payload);
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
#if defined(__APPLE__) || defined(__linux__)
    if (child_.running()) {
      terminate_process(child_);
      close_fd(child_.stdinFd);
      close_fd(child_.stdoutFd);
      ::waitpid(child_.pid, nullptr, 0);
      child_.pid = -1;
    }
#endif

    if (readerThread_.joinable()) {
      readerThread_.join();
    }
    fail_pending_requests("Matter worker stopped");
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

  [[nodiscard]] fs::path worker_script_path() const {
    const std::string explicitPath = getenv_or_empty("MATTERKIOSK_WORKER_SCRIPT");
    if (!explicitPath.empty()) {
      return explicitPath;
    }
    return resource_root_path() / "app.asar" / "dist" / "main" / "matter-worker.js";
  }

  [[nodiscard]] fs::path worker_executable_path() const {
    const std::string explicitPath = getenv_or_empty("MATTERKIOSK_WORKER_EXECUTABLE");
    if (!explicitPath.empty()) {
      return explicitPath;
    }
    return electron_executable_path();
  }

  [[nodiscard]] fs::path electron_executable_path() const {
    const std::string explicitPath = getenv_or_empty("MATTERKIOSK_ELECTRON_EXECUTABLE");
    if (!explicitPath.empty()) {
      return explicitPath;
    }

    const fs::path resourceRoot = resource_root_path();
    if (resourceRoot.empty()) {
      return current_executable_path();
    }

#ifdef __APPLE__
    return resourceRoot.parent_path() / "MacOS" / "MatterKiosk";
#else
    return resourceRoot.parent_path() / "MatterKiosk";
#endif
  }

  [[nodiscard]] std::map<std::string, std::string> worker_environment() const {
    std::map<std::string, std::string> env;
    env["ELECTRON_RUN_AS_NODE"] = "1";

    const std::string cryptoFallback = getenv_or_empty("MATTER_NODEJS_CRYPTO");
    if (!cryptoFallback.empty()) {
      env["MATTER_NODEJS_CRYPTO"] = cryptoFallback;
    }

    return env;
  }

  std::string storagePath_;
  ChildProcess child_;
  std::thread readerThread_;
  MatterStatus status_;
  std::atomic<int> nextRequestId_{1};
  std::mutex pendingMutex_;
  std::unordered_map<int, std::shared_ptr<PendingResponse>> pendingRequests_;
  EventHandler onAccessoryTurnedOn_;
  EventHandler onAccessoryTurnedOff_;
  LevelChangedHandler onAccessoryLevelChanged_;
};

}  // namespace

std::unique_ptr<MatterRuntime> create_worker_matter_runtime(std::string storagePath) {
  return std::make_unique<MatterWorkerRuntime>(std::move(storagePath));
}