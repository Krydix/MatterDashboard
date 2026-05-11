#include "volume_controller.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#if defined(__APPLE__) || defined(__linux__)
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace {

class UnsupportedVolumeController final : public VolumeController {
 public:
  bool isSupported() const override { return false; }

  VolumeControlState getState() override {
    throw std::runtime_error("Host volume control is not supported on this platform.");
  }

  void setMuted(bool) override {
    throw std::runtime_error("Host volume control is not supported on this platform.");
  }

  void setLevel(int) override {
    throw std::runtime_error("Host volume control is not supported on this platform.");
  }
};

#if defined(__APPLE__)
[[nodiscard]] std::string run_and_capture(const std::vector<std::string> &args) {
  int stdoutPipe[2];
  if (::pipe(stdoutPipe) != 0) {
    throw std::runtime_error("Failed to create osascript pipe");
  }

  const pid_t pid = ::fork();
  if (pid < 0) {
    ::close(stdoutPipe[0]);
    ::close(stdoutPipe[1]);
    throw std::runtime_error("Failed to fork osascript process");
  }

  if (pid == 0) {
    ::dup2(stdoutPipe[1], STDOUT_FILENO);
    ::close(stdoutPipe[0]);
    ::close(stdoutPipe[1]);

    std::vector<char *> argv;
    argv.reserve(args.size() + 2);
    argv.push_back(const_cast<char *>("/usr/bin/osascript"));
    for (const auto &arg : args) {
      argv.push_back(const_cast<char *>(arg.c_str()));
    }
    argv.push_back(nullptr);

    ::execv("/usr/bin/osascript", argv.data());
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
      throw std::runtime_error("Failed to read osascript output");
    }
    output.append(buffer.data(), static_cast<std::size_t>(bytesRead));
  }

  ::close(stdoutPipe[0]);

  int status = 0;
  if (::waitpid(pid, &status, 0) < 0) {
    throw std::runtime_error("Failed to wait for osascript process");
  }
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    throw std::runtime_error("osascript exited with a failure status");
  }

  return output;
}

[[nodiscard]] std::string trim_ascii(std::string value) {
  while (!value.empty() && (value.front() == ' ' || value.front() == '\n' || value.front() == '\r' || value.front() == '\t')) {
    value.erase(value.begin());
  }
  while (!value.empty() && (value.back() == ' ' || value.back() == '\n' || value.back() == '\r' || value.back() == '\t')) {
    value.pop_back();
  }
  return value;
}

class MacVolumeController final : public VolumeController {
 public:
  bool isSupported() const override { return true; }

  VolumeControlState getState() override {
    const std::string output = trim_ascii(run_and_capture({
        "-e", "set v to output volume of (get volume settings)",
        "-e", "set m to output muted of (get volume settings)",
        "-e", "return (v as string) & \",\" & (m as string)",
    }));

    const std::size_t separator = output.find(',');
    if (separator == std::string::npos) {
      throw std::runtime_error("Unexpected osascript volume state response");
    }

    const int level = std::clamp(std::stoi(output.substr(0, separator)), 0, 100);
    const std::string muted = trim_ascii(output.substr(separator + 1));

    return VolumeControlState{
        .muted = muted == "true",
        .level = level,
    };
  }

  void setMuted(bool muted) override {
    run_and_capture({"-e", std::string("set volume output muted ") + (muted ? "true" : "false")});
  }

  void setLevel(int level) override {
    run_and_capture({"-e", "set volume output volume " + std::to_string(std::clamp(level, 0, 100))});
  }
};
#endif

}  // namespace

std::unique_ptr<VolumeController> create_volume_controller() {
#if defined(__APPLE__)
  return std::make_unique<MacVolumeController>();
#else
  return std::make_unique<UnsupportedVolumeController>();
#endif
}