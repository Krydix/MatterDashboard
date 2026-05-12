#include "brightness_controller.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstddef>
#include <cstdlib>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

#if defined(__APPLE__) || defined(__linux__)
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;

namespace {

class UnsupportedBrightnessController final : public BrightnessController {
 public:
  bool isSupported() const override { return false; }

  BrightnessControlState getState(int) override {
    throw std::runtime_error("Host brightness control is not supported on this platform.");
  }

  void setLevel(int, int) override {
    throw std::runtime_error("Host brightness control is not supported on this platform.");
  }
};

#if defined(__APPLE__) && (defined(__aarch64__) || defined(__arm64__))
[[nodiscard]] std::string trim_ascii(std::string value) {
  while (!value.empty() && (value.front() == ' ' || value.front() == '\n' || value.front() == '\r' || value.front() == '\t')) {
    value.erase(value.begin());
  }
  while (!value.empty() && (value.back() == ' ' || value.back() == '\n' || value.back() == '\r' || value.back() == '\t')) {
    value.pop_back();
  }
  return value;
}

[[nodiscard]] std::string platform_arch_dir() {
  return "darwin-arm64";
}

[[nodiscard]] fs::path current_executable_path() {
  uint32_t size = 0;
  _NSGetExecutablePath(nullptr, &size);
  std::string buffer(size, '\0');
  if (_NSGetExecutablePath(buffer.data(), &size) != 0) {
    throw std::runtime_error("Failed to resolve brightness helper executable path");
  }
  return fs::weakly_canonical(fs::path(buffer.c_str()));
}

[[nodiscard]] std::vector<fs::path> helper_candidate_paths() {
  std::vector<fs::path> candidates;

  const fs::path executablePath = current_executable_path();
  candidates.push_back(executablePath.parent_path().parent_path().parent_path().parent_path() / "m1ddc");

  const char *uiAppPath = std::getenv("MATTERKIOSK_UI_APP_PATH");
  if (uiAppPath != nullptr && std::string(uiAppPath).size() > 0) {
    candidates.push_back(fs::path(uiAppPath) / "assets" / "native" / platform_arch_dir() / "m1ddc");
  }

  return candidates;
}

[[nodiscard]] fs::path resolve_helper_path() {
  const auto candidates = helper_candidate_paths();
  for (const auto &candidate : candidates) {
    if (fs::exists(candidate)) {
      return candidate;
    }
  }

  return fs::path("m1ddc");
}

[[nodiscard]] std::string run_and_capture(const fs::path &executable, const std::vector<std::string> &args) {
  int stdoutPipe[2];
  if (::pipe(stdoutPipe) != 0) {
    throw std::runtime_error("Failed to create brightness helper pipe");
  }

  const pid_t pid = ::fork();
  if (pid < 0) {
    ::close(stdoutPipe[0]);
    ::close(stdoutPipe[1]);
    throw std::runtime_error("Failed to fork brightness helper process");
  }

  if (pid == 0) {
    ::dup2(stdoutPipe[1], STDOUT_FILENO);
    ::close(stdoutPipe[0]);
    ::close(stdoutPipe[1]);

    std::vector<char *> argv;
    argv.reserve(args.size() + 2);
    argv.push_back(const_cast<char *>(executable.c_str()));
    for (const auto &arg : args) {
      argv.push_back(const_cast<char *>(arg.c_str()));
    }
    argv.push_back(nullptr);

    if (executable.is_absolute()) {
      ::execv(executable.c_str(), argv.data());
    } else {
      ::execvp(executable.c_str(), argv.data());
    }
    std::_Exit(127);
  }

  ::close(stdoutPipe[1]);

  std::string output;
  std::array<char, 256> buffer{};
  while (true) {
    const auto bytesRead = ::read(stdoutPipe[0], buffer.data(), buffer.size());
    if (bytesRead == 0) {
      break;
    }
    if (bytesRead < 0) {
      if (errno == EINTR) {
        continue;
      }
      ::close(stdoutPipe[0]);
      ::waitpid(pid, nullptr, 0);
      throw std::runtime_error("Failed to read brightness helper output");
    }
    output.append(buffer.data(), static_cast<std::size_t>(bytesRead));
  }

  ::close(stdoutPipe[0]);

  int status = 0;
  if (::waitpid(pid, &status, 0) < 0) {
    throw std::runtime_error("Failed to wait for brightness helper process");
  }
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    throw std::runtime_error("Brightness helper exited with a failure status");
  }

  return trim_ascii(output);
}

[[nodiscard]] int parse_brightness_level(const std::string &output) {
  const std::size_t start = output.find_first_of("-0123456789");
  if (start == std::string::npos) {
    throw std::runtime_error("Unexpected brightness helper response");
  }

  std::size_t end = start + 1;
  while (end < output.size() && ((output[end] >= '0' && output[end] <= '9') || output[end] == '.')) {
    ++end;
  }

  return std::clamp(static_cast<int>(std::stod(output.substr(start, end - start))), 0, 100);
}

class MacBrightnessController final : public BrightnessController {
 public:
  bool isSupported() const override { return true; }

  BrightnessControlState getState(int displayId) override {
    const std::string output = run_and_capture(
        resolve_helper_path(), {"display", "id=" + std::to_string(displayId), "get", "luminance"});

    return BrightnessControlState{
        .level = parse_brightness_level(output),
    };
  }

  void setLevel(int displayId, int level) override {
    run_and_capture(resolve_helper_path(),
                    {"display", "id=" + std::to_string(displayId), "set", "luminance",
                     std::to_string(std::clamp(level, 0, 100))});
  }
};
#endif

}  // namespace

std::unique_ptr<BrightnessController> create_brightness_controller() {
#if defined(__APPLE__) && (defined(__aarch64__) || defined(__arm64__))
  return std::make_unique<MacBrightnessController>();
#else
  return std::make_unique<UnsupportedBrightnessController>();
#endif
}
