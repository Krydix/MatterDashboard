#include "matter_runtime.hpp"

#include <cstdlib>
#include <stdexcept>
#include <string>

namespace {

[[nodiscard]] std::string getenv_or_empty(const char *name) {
  const char *value = std::getenv(name);
  return value == nullptr ? std::string() : std::string(value);
}

}  // namespace

std::unique_ptr<MatterRuntime> create_matter_runtime(std::string storagePath) {
  const std::string runtimeKind = getenv_or_empty("MATTERKIOSK_MATTER_RUNTIME");
  if (runtimeKind.empty() || runtimeKind == "worker") {
    return create_worker_matter_runtime(std::move(storagePath));
  }

  if (runtimeKind == "chip") {
#if MATTERKIOSK_HAVE_CONNECTEDHOMEIP
    return create_chip_process_matter_runtime(std::move(storagePath));
#else
    throw std::runtime_error("CHIP runtime selection requested, but connectedhomeip is not available in this build.");
#endif
  }

  throw std::runtime_error("Unsupported MATTERKIOSK_MATTER_RUNTIME value: " + runtimeKind);
}