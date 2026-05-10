#pragma once

#include "daemon_types.hpp"

#include <functional>
#include <memory>
#include <string>
#include <vector>

class MatterRuntime {
 public:
  using EventHandler = std::function<void(const std::string &)>;

  virtual ~MatterRuntime() = default;

  virtual void setTargetTriggeredHandler(EventHandler handler) = 0;
  virtual void setTargetTurnedOffHandler(EventHandler handler) = 0;
  virtual MatterStatus start(const std::vector<KioskTarget> &targets) = 0;
  virtual MatterStatus syncTargets(const std::vector<KioskTarget> &targets) = 0;
  virtual MatterStatus getStatus() = 0;
  virtual MatterStatus reset() = 0;
  virtual void setTargetOff(const std::string &targetId) = 0;
  virtual void stop() = 0;
};

std::unique_ptr<MatterRuntime> create_worker_matter_runtime(std::string storagePath);
std::unique_ptr<MatterRuntime> create_chip_process_matter_runtime(std::string storagePath);
std::unique_ptr<MatterRuntime> create_matter_runtime(std::string storagePath);