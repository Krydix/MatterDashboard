#include "matter_runtime.hpp"
#include "mini_json.hpp"

#include <atomic>
#include <cerrno>
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
      : runtime_(create_matter_runtime(matter_storage_path().string())) {
    runtime_->setTargetTriggeredHandler([this](const std::string &targetId) { handle_target_triggered(targetId); });
    runtime_->setTargetTurnedOffHandler([this](const std::string &targetId) { handle_target_turned_off(targetId); });
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
    if (config_.backgroundDaemonEnabled) {
      status_ = runtime_->start(config_.targets);
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
        if (config_.backgroundDaemonEnabled) {
          status_ = runtime_->syncTargets(config_.targets);
        } else {
          runtime_->stop();
          status_ = {};
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

  void handle_target_triggered(const std::string &targetId) {
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
          runtime_->setTargetOff(targetId);
        } catch (const std::exception &error) {
          std::cerr << "Failed to clear target " << targetId << ": " << error.what() << "\n";
        }
      }
    }).detach();
#endif
  }

  void handle_target_turned_off(const std::string &targetId) {
    std::lock_guard<std::mutex> lock(dashboardMutex_);
    const auto it = activeDashboards_.find(targetId);
    if (it == activeDashboards_.end()) {
      return;
    }
    terminate_process(it->second);
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
  std::atomic<bool> shuttingDown_{false};
  std::mutex dashboardMutex_;
  std::map<std::string, ChildProcess> activeDashboards_;
  int serverFd_ = -1;
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