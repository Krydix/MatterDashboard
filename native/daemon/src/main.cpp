#include "brightness_controller.hpp"
#include "matter_runtime.hpp"
#include "mini_json.hpp"
#include "volume_controller.hpp"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <mutex>
#include <memory>
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
#include <fcntl.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
#endif

using mkjson::JsonValue;
namespace fs = std::filesystem;

namespace {

struct AppConfig {
  std::vector<KioskTarget> targets;
  int presentationDisplayId = 0;
  BrightnessControlConfig brightnessControl;
  VolumeControlConfig volumeControl;
  bool launchAtLogin = false;
  bool backgroundDaemonEnabled = false;
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

std::atomic<bool> g_interrupted = false;
int g_server_fd = -1;

constexpr const char *kVolumeAccessoryId = "system-volume";
constexpr const char *kBrightnessAccessoryId = "display-brightness";
constexpr auto kBrightnessStatePollInterval = std::chrono::seconds(2);
constexpr auto kVolumeStatePollInterval = std::chrono::seconds(2);
constexpr auto kVolumeOffDebounceWindow = std::chrono::milliseconds(750);

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

[[nodiscard]] std::uint8_t percent_to_matter_level(int percent) {
  percent = std::clamp(percent, 0, 100);
  if (percent <= 0) {
    return 1;
  }
  return static_cast<std::uint8_t>(std::clamp((percent * 254 + 99) / 100, 1, 254));
}

[[nodiscard]] int matter_level_to_percent(std::uint8_t level) {
  if (level == 0) {
    return 0;
  }

  return std::clamp((static_cast<int>(level) * 100 + 253) / 254, 1, 100);
}

[[nodiscard]] bool same_volume_control_state(const VolumeControlState &lhs, const VolumeControlState &rhs) {
  return lhs.muted == rhs.muted && lhs.level == rhs.level;
}

[[nodiscard]] bool same_brightness_control_state(const BrightnessControlState &lhs, const BrightnessControlState &rhs) {
  return lhs.level == rhs.level;
}

[[nodiscard]] MatterAccessory build_volume_accessory(std::string name, const VolumeControlState &state) {
  return MatterAccessory{
      .id = kVolumeAccessoryId,
      .name = std::move(name),
      .kind = MatterAccessoryKind::Volume,
      .deviceType = MatterAccessoryDeviceType::DimmableLight,
      .url = {},
      .durationSeconds = 0,
      .enabled = true,
      .on = !state.muted,
      .level = percent_to_matter_level(state.level),
  };
}

[[nodiscard]] MatterAccessory build_brightness_accessory(std::string name, const BrightnessControlState &state) {
  return MatterAccessory{
      .id = kBrightnessAccessoryId,
      .name = std::move(name),
      .kind = MatterAccessoryKind::Brightness,
      .deviceType = MatterAccessoryDeviceType::DimmableLight,
      .url = {},
      .durationSeconds = 0,
      .enabled = true,
      .on = state.level > 0,
      .level = percent_to_matter_level(state.level),
  };
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

[[nodiscard]] std::string app_directory_name() {
  return "matter-kiosk";
}

[[nodiscard]] fs::path app_data_dir() {
#if defined(__APPLE__)
  return fs::path(getenv_or_empty("HOME")) / "Library" / "Application Support" / app_directory_name();
#elif defined(_WIN32)
  const std::string appData = getenv_or_empty("APPDATA");
  if (!appData.empty()) {
    return fs::path(appData) / app_directory_name();
  }
  return fs::current_path() / app_directory_name();
#else
  const std::string xdg = getenv_or_empty("XDG_CONFIG_HOME");
  if (!xdg.empty()) {
    return fs::path(xdg) / app_directory_name();
  }
  return fs::path(getenv_or_empty("HOME")) / ".config" / app_directory_name();
#endif
}

[[nodiscard]] fs::path config_path() {
  return app_data_dir() / "config.json";
}

[[nodiscard]] fs::path matter_storage_path() {
  return app_data_dir() / "matter-storage";
}

[[nodiscard]] fs::path runtime_dir() {
  return app_data_dir() / "runtime";
}

[[nodiscard]] fs::path daemon_socket_path() {
#if defined(_WIN32)
  return fs::path(R"(\\.\pipe\matterkiosk-daemon)");
#else
  return runtime_dir() / "daemon.sock";
#endif
}

[[nodiscard]] fs::path daemon_pid_path() {
  return runtime_dir() / "daemon.pid";
}

void ensure_directory(const fs::path &path) {
  std::error_code error;
  fs::create_directories(path, error);
  if (error) {
    throw std::runtime_error("Failed to create directory: " + path.string());
  }
}

[[nodiscard]] AppConfig parse_config(const JsonValue &value) {
  AppConfig config;

  if (!value.is_object()) {
    return config;
  }

  config.launchAtLogin = bool_or(value, "launchAtLogin", false);
  config.backgroundDaemonEnabled = bool_or(value, "backgroundDaemonEnabled", config.launchAtLogin);
  config.presentationDisplayId = int_or(value, "presentationDisplayId", 0);

  if (const JsonValue *brightnessControl = value.find("brightnessControl"); brightnessControl != nullptr && brightnessControl->is_object()) {
    config.brightnessControl.enabled = bool_or(*brightnessControl, "enabled", false);
    if (const JsonValue *name = brightnessControl->find("name"); name != nullptr && name->is_string() && !name->as_string().empty()) {
      config.brightnessControl.name = name->as_string();
    }
  }

  if (const JsonValue *volumeControl = value.find("volumeControl"); volumeControl != nullptr && volumeControl->is_object()) {
    config.volumeControl.enabled = bool_or(*volumeControl, "enabled", false);
    if (const JsonValue *name = volumeControl->find("name"); name != nullptr && name->is_string() && !name->as_string().empty()) {
      config.volumeControl.name = name->as_string();
    }
  }

  const JsonValue *targets = value.find("targets");
  if (targets == nullptr || !targets->is_array()) {
    return config;
  }

  for (const JsonValue &entry : targets->as_array()) {
    if (!entry.is_object()) {
      continue;
    }

    try {
      KioskTarget target;
      target.id = require_string(entry, "id");
      target.name = require_string(entry, "name");
      target.url = require_string(entry, "url");
      target.durationSeconds = int_or(entry, "durationSeconds", 30);
      target.enabled = bool_or(entry, "enabled", true);
      config.targets.push_back(std::move(target));
    } catch (...) {
    }
  }

  return config;
}

[[nodiscard]] AppConfig load_config_from_disk() {
  try {
    std::ifstream stream(config_path());
    if (!stream) {
      return {};
    }

    std::stringstream buffer;
    buffer << stream.rdbuf();
    return parse_config(mkjson::parse(buffer.str()));
  } catch (...) {
    return {};
  }
}

[[nodiscard]] JsonValue targets_to_json(const std::vector<KioskTarget> &targets) {
  JsonValue::Array array;
  array.reserve(targets.size());

  for (const auto &target : targets) {
    array.emplace_back(JsonValue::Object{
      {"id", target.id},
      {"name", target.name},
      {"url", target.url},
      {"durationSeconds", target.durationSeconds},
      {"enabled", target.enabled},
    });
  }

  return JsonValue(std::move(array));
}

[[nodiscard]] JsonValue status_to_json(const MatterStatus &status) {
  return JsonValue::Object{
    {"started", status.started},
    {"paired", status.paired},
    {"qrCode", status.qrCode},
    {"manualPairingCode", status.manualPairingCode},
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

ChildProcess spawn_dashboard_process(const fs::path &executable,
                                     const std::vector<std::string> &args,
                                     const std::map<std::string, std::string> &envOverrides) {
  const pid_t pid = ::fork();
  if (pid < 0) {
    throw std::runtime_error("Failed to fork dashboard process");
  }

  if (pid == 0) {
    for (const auto &[key, value] : envOverrides) {
      if (value.empty()) {
        ::unsetenv(key.c_str());
      } else {
        ::setenv(key.c_str(), value.c_str(), 1);
      }
    }

    const int nullFd = ::open("/dev/null", O_RDWR);
    if (nullFd >= 0) {
      ::dup2(nullFd, STDIN_FILENO);
      ::dup2(nullFd, STDOUT_FILENO);
      ::dup2(nullFd, STDERR_FILENO);
      ::close(nullFd);
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

  return ChildProcess{pid, -1, -1};
}

void terminate_process(const ChildProcess &process) {
  if (process.pid > 0) {
    ::kill(process.pid, SIGTERM);
  }
}

bool try_ping_existing_daemon(const fs::path &socketPath) {
  const int client = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (client < 0) {
    return false;
  }

  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  std::snprintf(address.sun_path, sizeof(address.sun_path), "%s", socketPath.c_str());

  const int connected = ::connect(client, reinterpret_cast<sockaddr *>(&address), sizeof(address));
  if (connected != 0) {
    ::close(client);
    return false;
  }

  const std::string request = "{\"type\":\"ping\"}\n";
  write_all(client, request);
  std::string response;
  const bool ok = read_line(client, response);
  ::close(client);

  if (!ok) {
    return false;
  }

  try {
    const JsonValue parsed = mkjson::parse(response);
    return bool_or(parsed, "ok", false);
  } catch (...) {
    return false;
  }
}
#endif

class NativeDaemon {
 public:
  NativeDaemon()
      : runtime_(create_matter_runtime(matter_storage_path().string())),
        brightnessController_(create_brightness_controller()),
        volumeController_(create_volume_controller()) {
    runtime_->setAccessoryTurnedOnHandler([this](const std::string &accessoryId) { handle_accessory_turned_on(accessoryId); });
    runtime_->setAccessoryTurnedOffHandler([this](const std::string &accessoryId) { handle_accessory_turned_off(accessoryId); });
    runtime_->setAccessoryLevelChangedHandler(
        [this](const std::string &accessoryId, std::uint8_t level) { handle_accessory_level_changed(accessoryId, level); });
  }

  int run() {
    ensure_directory(runtime_dir());

#if defined(__APPLE__) || defined(__linux__)
    const fs::path socketPath = daemon_socket_path();
    if (fs::exists(socketPath)) {
      if (try_ping_existing_daemon(socketPath)) {
        std::cerr << "Matter daemon is already running.\n";
        return 0;
      }
      std::error_code error;
      fs::remove(socketPath, error);
    }
#endif

    write_pid_file();
    config_ = load_config_from_disk();
    refresh_brightness_sync_settings();
    refresh_volume_sync_settings();
    start_brightness_polling();
    start_volume_polling();
    if (config_.backgroundDaemonEnabled) {
      status_ = runtime_->start(build_accessories());
      seed_published_brightness_state_from_host();
      seed_published_volume_state_from_host();
    }

    try {
      return run_control_server();
    } catch (...) {
      cleanup();
      throw;
    }
  }

  void interrupt() {
    shuttingDown_.store(true);
    if (serverFd_ >= 0) {
#if defined(__APPLE__) || defined(__linux__)
      ::close(serverFd_);
#endif
      serverFd_ = -1;
      g_server_fd = -1;
    }
  }

 private:
  int run_control_server() {
#if defined(__APPLE__) || defined(__linux__)
    serverFd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (serverFd_ < 0) {
      throw std::runtime_error("Failed to create daemon control socket");
    }
    g_server_fd = serverFd_;

    sockaddr_un address{};
    address.sun_family = AF_UNIX;
    std::snprintf(address.sun_path, sizeof(address.sun_path), "%s", daemon_socket_path().c_str());

    if (::bind(serverFd_, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0) {
      throw std::runtime_error("Failed to bind daemon control socket");
    }

    if (::listen(serverFd_, 8) != 0) {
      throw std::runtime_error("Failed to listen on daemon control socket");
    }

    while (!shuttingDown_.load() && !g_interrupted.load()) {
      const int client = ::accept(serverFd_, nullptr, nullptr);
      if (client < 0) {
        if (shuttingDown_.load() || g_interrupted.load()) {
          break;
        }
        if (errno == EINTR) {
          continue;
        }
        throw std::runtime_error("Failed to accept daemon control connection");
      }

      handle_client(client);
      ::close(client);
    }

    cleanup();
    return 0;
#else
    throw std::runtime_error("Native Matter daemon control server is only implemented on Unix-like hosts in this revision.");
#endif
  }

  void handle_client(int clientFd) {
#if defined(__APPLE__) || defined(__linux__)
    std::string requestLine;
    if (!read_line(clientFd, requestLine)) {
      return;
    }
    const std::string response = mkjson::stringify(handle_request(mkjson::parse(requestLine))) + "\n";
    write_all(clientFd, response);
#else
    (void)clientFd;
#endif
  }

  [[nodiscard]] JsonValue handle_request(const JsonValue &request) {
    try {
      const std::string type = require_string(request, "type");
      if (type == "ping") {
        return JsonValue::Object{{"ok", true}};
      }

      if (type == "get-status") {
        status_ = config_.backgroundDaemonEnabled ? runtime_->getStatus() : MatterStatus{};
        return JsonValue::Object{{"ok", true}, {"result", status_to_json(status_)}};
      }

      if (type == "sync-config") {
        const JsonValue *config = request.find("config");
        if (config == nullptr) {
          throw std::runtime_error("sync-config request missing config payload");
        }
        config_ = parse_config(*config);
        refresh_brightness_sync_settings();
        refresh_volume_sync_settings();
        if (config_.backgroundDaemonEnabled) {
          status_ = runtime_->syncAccessories(build_accessories());
          seed_published_brightness_state_from_host();
          seed_published_volume_state_from_host();
        } else {
          runtime_->stop();
          status_ = {};
          clear_published_brightness_state();
          clear_published_volume_state();
        }
        return JsonValue::Object{{"ok", true}};
      }

      if (type == "reset") {
        status_ = runtime_->reset();
        return JsonValue::Object{{"ok", true}, {"result", status_to_json(status_)}};
      }

      if (type == "shutdown") {
        interrupt();
        return JsonValue::Object{{"ok", true}};
      }

      return JsonValue::Object{{"ok", false}, {"error", "Unknown daemon request."}};
    } catch (const std::exception &error) {
      return JsonValue::Object{{"ok", false}, {"error", error.what()}};
    }
  }

  [[nodiscard]] std::vector<MatterAccessory> build_accessories() {
    std::vector<MatterAccessory> accessories;
    accessories.reserve(config_.targets.size() + 2);

    for (const auto &target : config_.targets) {
      accessories.push_back(MatterAccessory{
          .id = target.id,
          .name = target.name,
          .kind = MatterAccessoryKind::Dashboard,
          .deviceType = MatterAccessoryDeviceType::OnOffPlugInUnit,
          .url = target.url,
          .durationSeconds = target.durationSeconds,
          .enabled = target.enabled,
          .on = false,
          .level = 0,
      });
    }

    if (config_.volumeControl.enabled && volumeController_ && volumeController_->isSupported()) {
      try {
        const VolumeControlState state = volumeController_->getState();
        if (state.level > 0) {
          lastKnownVolumeLevel_.store(state.level);
        }
        accessories.push_back(build_volume_accessory(config_.volumeControl.name, state));
      } catch (const std::exception &error) {
        std::cerr << "Failed to read host volume state: " << error.what() << "\n";
      }
    }

    if (config_.brightnessControl.enabled && config_.presentationDisplayId > 0 && brightnessController_ && brightnessController_->isSupported()) {
      try {
        const BrightnessControlState state = brightnessController_->getState(config_.presentationDisplayId);
        if (state.level > 0) {
          lastKnownBrightnessLevel_.store(state.level);
        }
        accessories.push_back(build_brightness_accessory(config_.brightnessControl.name, state));
      } catch (const std::exception &error) {
        std::cerr << "Failed to read host brightness state: " << error.what() << "\n";
      }
    }

    return accessories;
  }

  void start_brightness_polling() {
    if (brightnessPollThread_.joinable()) {
      return;
    }

    brightnessPollThread_ = std::thread([this]() { poll_brightness_state_loop(); });
  }

  void refresh_brightness_sync_settings() {
    backgroundMatterEnabled_.store(config_.backgroundDaemonEnabled);

    const int displayId = config_.presentationDisplayId > 0 ? config_.presentationDisplayId : 0;
    const bool brightnessEnabled =
        config_.backgroundDaemonEnabled && config_.brightnessControl.enabled && displayId > 0 && brightnessController_ && brightnessController_->isSupported();
    brightnessBridgeEnabled_.store(brightnessEnabled);
    brightnessDisplayId_.store(displayId);

    std::lock_guard<std::mutex> lock(brightnessStateMutex_);
    brightnessAccessoryName_ = config_.brightnessControl.name;
    if (!brightnessEnabled) {
      publishedBrightnessState_.reset();
    }
  }

  [[nodiscard]] bool should_poll_brightness() const {
    return backgroundMatterEnabled_.load() && brightnessBridgeEnabled_.load();
  }

  void clear_published_brightness_state() {
    std::lock_guard<std::mutex> lock(brightnessStateMutex_);
    publishedBrightnessState_.reset();
  }

  void remember_published_brightness_state(const BrightnessControlState &state) {
    if (state.level > 0) {
      lastKnownBrightnessLevel_.store(state.level);
    }

    std::lock_guard<std::mutex> lock(brightnessStateMutex_);
    publishedBrightnessState_ = state;
  }

  [[nodiscard]] BrightnessControlState sanitize_brightness_readback(const BrightnessControlState &state) {
    if (state.level > 0) {
      return state;
    }

    std::lock_guard<std::mutex> lock(brightnessStateMutex_);
    if (allowZeroBrightnessReadback_) {
      return state;
    }

    if (publishedBrightnessState_.has_value() && publishedBrightnessState_->level > 0) {
      return *publishedBrightnessState_;
    }

    return state;
  }

  void seed_published_brightness_state_from_host() {
    if (!should_poll_brightness()) {
      clear_published_brightness_state();
      return;
    }

    const int displayId = brightnessDisplayId_.load();
    if (displayId <= 0) {
      clear_published_brightness_state();
      return;
    }

    try {
      remember_published_brightness_state(sanitize_brightness_readback(brightnessController_->getState(displayId)));
    } catch (const std::exception &error) {
      clear_published_brightness_state();
      std::cerr << "Failed to seed host brightness state tracking: " << error.what() << "\n";
    }
  }

  void poll_brightness_state_loop() {
    while (!shuttingDown_.load() && !g_interrupted.load()) {
      if (!should_poll_brightness()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
        continue;
      }

      const int displayId = brightnessDisplayId_.load();
      if (displayId <= 0) {
        std::this_thread::sleep_for(kBrightnessStatePollInterval);
        continue;
      }

      try {
        const BrightnessControlState state = sanitize_brightness_readback(brightnessController_->getState(displayId));

        std::string accessoryName;
        bool changed = false;
        {
          std::lock_guard<std::mutex> lock(brightnessStateMutex_);
          accessoryName = brightnessAccessoryName_;
          changed = !publishedBrightnessState_.has_value() || !same_brightness_control_state(*publishedBrightnessState_, state);
        }

        if (changed) {
          runtime_->setAccessoryState(build_brightness_accessory(accessoryName, state));
          remember_published_brightness_state(state);
        } else if (state.level > 0) {
          lastKnownBrightnessLevel_.store(state.level);
        }
      } catch (const std::exception &error) {
        std::cerr << "Failed to poll host brightness state: " << error.what() << "\n";
      }

      std::this_thread::sleep_for(kBrightnessStatePollInterval);
    }
  }

  void start_volume_polling() {
    if (volumePollThread_.joinable()) {
      return;
    }

    volumePollThread_ = std::thread([this]() { poll_volume_state_loop(); });
  }

  void refresh_volume_sync_settings() {
    backgroundMatterEnabled_.store(config_.backgroundDaemonEnabled);

    const bool volumeEnabled = config_.volumeControl.enabled && volumeController_ && volumeController_->isSupported();
    volumeBridgeEnabled_.store(volumeEnabled);

    std::lock_guard<std::mutex> lock(volumeStateMutex_);
    volumeAccessoryName_ = config_.volumeControl.name;
    if (!config_.backgroundDaemonEnabled || !volumeEnabled) {
      publishedVolumeState_.reset();
    }
  }

  [[nodiscard]] bool should_poll_volume() const {
    return backgroundMatterEnabled_.load() && volumeBridgeEnabled_.load();
  }

  void clear_published_volume_state() {
    std::lock_guard<std::mutex> lock(volumeStateMutex_);
    publishedVolumeState_.reset();
  }

  void remember_published_volume_state(const VolumeControlState &state) {
    if (state.level > 0) {
      lastKnownVolumeLevel_.store(state.level);
    }

    std::lock_guard<std::mutex> lock(volumeStateMutex_);
    publishedVolumeState_ = state;
  }

  void seed_published_volume_state_from_host() {
    if (!should_poll_volume()) {
      clear_published_volume_state();
      return;
    }

    try {
      remember_published_volume_state(volumeController_->getState());
    } catch (const std::exception &error) {
      clear_published_volume_state();
      std::cerr << "Failed to seed host volume state tracking: " << error.what() << "\n";
    }
  }

  void poll_volume_state_loop() {
    while (!shuttingDown_.load() && !g_interrupted.load()) {
      if (!should_poll_volume()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(250));
        continue;
      }

      try {
        const VolumeControlState state = volumeController_->getState();

        std::string accessoryName;
        bool changed = false;
        {
          std::lock_guard<std::mutex> lock(volumeStateMutex_);
          accessoryName = volumeAccessoryName_;
          changed = !publishedVolumeState_.has_value() || !same_volume_control_state(*publishedVolumeState_, state);
        }

        if (changed) {
          runtime_->setAccessoryState(build_volume_accessory(accessoryName, state));
          remember_published_volume_state(state);
        } else if (state.level > 0) {
          lastKnownVolumeLevel_.store(state.level);
        }
      } catch (const std::exception &error) {
        std::cerr << "Failed to poll host volume state: " << error.what() << "\n";
      }

      std::this_thread::sleep_for(kVolumeStatePollInterval);
    }
  }

  void handle_accessory_turned_on(const std::string &accessoryId) {
    if (accessoryId == kBrightnessAccessoryId) {
      handle_brightness_turned_on();
      return;
    }

    if (accessoryId == kVolumeAccessoryId) {
      handle_volume_turned_on();
      return;
    }

    handle_dashboard_triggered(accessoryId);
  }

  void handle_dashboard_triggered(const std::string &targetId) {
    std::optional<KioskTarget> target;
    {
      std::lock_guard<std::mutex> lock(dashboardMutex_);
      if (activeDashboards_.contains(targetId)) {
        return;
      }

      for (const auto &entry : config_.targets) {
        if (entry.id == targetId && entry.enabled) {
          target = entry;
          break;
        }
      }
    }

    if (!target.has_value()) {
      return;
    }

#if defined(__APPLE__) || defined(__linux__)
    ChildProcess child = spawn_dashboard_process(dashboard_executable_path(), dashboard_arguments(target->id), dashboard_environment());

    {
      std::lock_guard<std::mutex> lock(dashboardMutex_);
      activeDashboards_[target->id] = child;
    }

    std::thread([this, targetId = target->id, pid = child.pid]() {
      ::waitpid(pid, nullptr, 0);
      {
        std::lock_guard<std::mutex> lock(dashboardMutex_);
        activeDashboards_.erase(targetId);
      }
      if (!shuttingDown_.load()) {
        try {
          runtime_->setAccessoryOff(targetId);
        } catch (const std::exception &error) {
          std::cerr << "Failed to clear target " << targetId << ": " << error.what() << "\n";
        }
      }
    }).detach();
#endif
  }

  void handle_accessory_turned_off(const std::string &accessoryId) {
    if (accessoryId == kBrightnessAccessoryId) {
      handle_brightness_turned_off();
      return;
    }

    if (accessoryId == kVolumeAccessoryId) {
      handle_volume_turned_off();
      return;
    }

    const std::string &targetId = accessoryId;
    std::lock_guard<std::mutex> lock(dashboardMutex_);
    const auto it = activeDashboards_.find(targetId);
    if (it == activeDashboards_.end()) {
      return;
    }
    terminate_process(it->second);
  }

  void handle_accessory_level_changed(const std::string &accessoryId, std::uint8_t level) {
    if (accessoryId == kBrightnessAccessoryId) {
      handle_brightness_level_changed(level);
      return;
    }

    if (accessoryId != kVolumeAccessoryId) {
      return;
    }

    handle_volume_level_changed(level);
  }

  void handle_volume_turned_on() {
    if (!volumeController_ || !volumeController_->isSupported()) {
      return;
    }

    try {
      const VolumeControlState state = volumeController_->getState();
      if (state.level > 0) {
        lastKnownVolumeLevel_.store(state.level);
      }

      volumeController_->setMuted(false);
      if (state.level <= 0) {
        const int restoredLevel = std::clamp(lastKnownVolumeLevel_.load(), 1, 100);
        volumeController_->setLevel(restoredLevel);
        lastKnownVolumeLevel_.store(restoredLevel);
      }
      seed_published_volume_state_from_host();
    } catch (const std::exception &error) {
      std::cerr << "Failed to turn host volume on: " << error.what() << "\n";
    }
  }

  void handle_brightness_turned_on() {
    const int displayId = brightnessDisplayId_.load();
    if (!brightnessController_ || !brightnessController_->isSupported() || displayId <= 0) {
      return;
    }

    try {
      const BrightnessControlState state = brightnessController_->getState(displayId);
      if (state.level > 0) {
        lastKnownBrightnessLevel_.store(state.level);
      }

      if (state.level <= 0) {
        const int restoredLevel = std::clamp(lastKnownBrightnessLevel_.load(), 1, 100);
        {
          std::lock_guard<std::mutex> lock(brightnessStateMutex_);
          allowZeroBrightnessReadback_ = false;
        }
        brightnessController_->setLevel(displayId, restoredLevel);
        remember_published_brightness_state(BrightnessControlState{.level = restoredLevel});
        lastKnownBrightnessLevel_.store(restoredLevel);
      } else {
        std::lock_guard<std::mutex> lock(brightnessStateMutex_);
        allowZeroBrightnessReadback_ = false;
      }
      seed_published_brightness_state_from_host();
    } catch (const std::exception &error) {
      std::cerr << "Failed to turn host brightness on: " << error.what() << "\n";
    }
  }

  void handle_brightness_turned_off() {
    const int displayId = brightnessDisplayId_.load();
    if (!brightnessController_ || !brightnessController_->isSupported() || displayId <= 0) {
      return;
    }

    try {
      const BrightnessControlState state = brightnessController_->getState(displayId);
      if (state.level > 0) {
        lastKnownBrightnessLevel_.store(state.level);
      }
      {
        std::lock_guard<std::mutex> lock(brightnessStateMutex_);
        allowZeroBrightnessReadback_ = true;
      }
      brightnessController_->setLevel(displayId, 0);
      remember_published_brightness_state(BrightnessControlState{.level = 0});
      seed_published_brightness_state_from_host();
    } catch (const std::exception &error) {
      std::cerr << "Failed to turn host brightness off: " << error.what() << "\n";
    }
  }

  void handle_brightness_level_changed(std::uint8_t level) {
    const int displayId = brightnessDisplayId_.load();
    if (!brightnessController_ || !brightnessController_->isSupported() || displayId <= 0) {
      return;
    }

    try {
      const int percent = matter_level_to_percent(level);
      if (percent > 0) {
        lastKnownBrightnessLevel_.store(percent);
      }

      {
        std::lock_guard<std::mutex> lock(brightnessStateMutex_);
        allowZeroBrightnessReadback_ = percent <= 0;
      }

      brightnessController_->setLevel(displayId, percent);
      remember_published_brightness_state(BrightnessControlState{.level = percent});
      seed_published_brightness_state_from_host();
    } catch (const std::exception &error) {
      std::cerr << "Failed to set host brightness level: " << error.what() << "\n";
    }
  }

  void handle_volume_turned_off() {
    if (!volumeController_ || !volumeController_->isSupported()) {
      return;
    }

    {
      std::lock_guard<std::mutex> lock(volumeStateMutex_);
      if (std::chrono::steady_clock::now() < ignoreVolumeOffUntil_) {
        return;
      }
    }

    try {
      const VolumeControlState state = volumeController_->getState();
      if (!state.muted && state.level > 0) {
        lastKnownVolumeLevel_.store(state.level);
      }
      volumeController_->setMuted(true);
      seed_published_volume_state_from_host();
    } catch (const std::exception &error) {
      std::cerr << "Failed to mute host volume: " << error.what() << "\n";
    }
  }

  void handle_volume_level_changed(std::uint8_t level) {
    if (!volumeController_ || !volumeController_->isSupported()) {
      return;
    }

    try {
      const int percent = matter_level_to_percent(level);
      if (percent > 0) {
        std::lock_guard<std::mutex> lock(volumeStateMutex_);
        ignoreVolumeOffUntil_ = std::chrono::steady_clock::now() + kVolumeOffDebounceWindow;
        lastKnownVolumeLevel_.store(percent);
      }

      volumeController_->setLevel(percent);
      if (percent > 0) {
        volumeController_->setMuted(false);
      }
      seed_published_volume_state_from_host();
    } catch (const std::exception &error) {
      std::cerr << "Failed to set host volume level: " << error.what() << "\n";
    }
  }

  [[nodiscard]] fs::path resource_root_path() const {
    const std::string explicitRoot = getenv_or_empty("MATTERKIOSK_RESOURCE_ROOT");
    if (!explicitRoot.empty()) {
      return explicitRoot;
    }

    const fs::path executable = current_executable_path();
    const fs::path maybeResources = executable.parent_path().parent_path().parent_path();
    if (fs::exists(maybeResources / "app.asar")) {
      return maybeResources;
    }
    return {};
  }

  [[nodiscard]] fs::path dashboard_executable_path() const {
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

  [[nodiscard]] std::vector<std::string> dashboard_arguments(const std::string &targetId) const {
    std::vector<std::string> args;
    const std::string uiAppPath = getenv_or_empty("MATTERKIOSK_UI_APP_PATH");
    if (!uiAppPath.empty()) {
      args.push_back(uiAppPath);
    }
    args.push_back("--dashboard-target-id=" + targetId);
    return args;
  }

  [[nodiscard]] std::map<std::string, std::string> dashboard_environment() const {
    return {{"ELECTRON_RUN_AS_NODE", ""}};
  }

  void write_pid_file() {
    ensure_directory(runtime_dir());
    std::ofstream stream(daemon_pid_path());
#if defined(__APPLE__) || defined(__linux__)
    stream << ::getpid() << "\n";
#else
    stream << "0\n";
#endif
  }

  void cleanup() {
    shuttingDown_.store(true);

    if (brightnessPollThread_.joinable()) {
      brightnessPollThread_.join();
    }

    if (volumePollThread_.joinable()) {
      volumePollThread_.join();
    }

    runtime_->stop();

    {
      std::lock_guard<std::mutex> lock(dashboardMutex_);
      for (const auto &[targetId, child] : activeDashboards_) {
        (void)targetId;
        terminate_process(child);
      }
      activeDashboards_.clear();
    }

#if defined(__APPLE__) || defined(__linux__)
    if (serverFd_ >= 0) {
      ::close(serverFd_);
      serverFd_ = -1;
      g_server_fd = -1;
    }
#endif

    std::error_code error;
    fs::remove(daemon_pid_path(), error);
#if !defined(_WIN32)
    fs::remove(daemon_socket_path(), error);
#endif
  }

  AppConfig config_;
  MatterStatus status_;
  std::unique_ptr<MatterRuntime> runtime_;
  std::unique_ptr<BrightnessController> brightnessController_;
  std::unique_ptr<VolumeController> volumeController_;
  std::atomic<bool> shuttingDown_{false};
  std::atomic<bool> backgroundMatterEnabled_{false};
  std::atomic<bool> brightnessBridgeEnabled_{false};
  std::atomic<bool> volumeBridgeEnabled_{false};
  std::mutex dashboardMutex_;
  std::mutex brightnessStateMutex_;
  std::mutex volumeStateMutex_;
  std::map<std::string, ChildProcess> activeDashboards_;
  std::thread brightnessPollThread_;
  std::thread volumePollThread_;
  std::optional<BrightnessControlState> publishedBrightnessState_;
  std::optional<VolumeControlState> publishedVolumeState_;
  bool allowZeroBrightnessReadback_ = true;
  std::string brightnessAccessoryName_ = "Brightness";
  std::string volumeAccessoryName_ = "Volume";
  std::chrono::steady_clock::time_point ignoreVolumeOffUntil_{};
  int serverFd_ = -1;
  std::atomic<int> brightnessDisplayId_{0};
  std::atomic<int> lastKnownBrightnessLevel_{50};
  std::atomic<int> lastKnownVolumeLevel_{50};
};

void signal_handler(int) {
  g_interrupted.store(true);
  if (g_server_fd >= 0) {
#if defined(__APPLE__) || defined(__linux__)
    ::close(g_server_fd);
#endif
    g_server_fd = -1;
  }
}

}  // namespace

int main() {
  std::signal(SIGINT, signal_handler);
  std::signal(SIGTERM, signal_handler);

  try {
    NativeDaemon daemon;
    return daemon.run();
  } catch (const std::exception &error) {
    std::cerr << "[NativeDaemon] Fatal error: " << error.what() << "\n";
    return 1;
  }
}