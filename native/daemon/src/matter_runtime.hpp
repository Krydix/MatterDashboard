#pragma once

#include "daemon_types.hpp"

#include <functional>
#include <memory>
#include <string>
#include <vector>

class MatterRuntime {
 public:
  using EventHandler = std::function<void(const std::string &)>;
  using LevelChangedHandler = std::function<void(const std::string &, std::uint8_t)>;

  virtual ~MatterRuntime() = default;

  virtual void setAccessoryTurnedOnHandler(EventHandler handler) = 0;
  virtual void setAccessoryTurnedOffHandler(EventHandler handler) = 0;
  virtual void setAccessoryLevelChangedHandler(LevelChangedHandler handler) = 0;
  virtual MatterStatus start(const std::vector<MatterAccessory> &accessories) = 0;
  virtual MatterStatus syncAccessories(const std::vector<MatterAccessory> &accessories) = 0;
  virtual void setAccessoryState(const MatterAccessory &accessory) = 0;
  virtual MatterStatus getStatus() = 0;
  virtual MatterStatus reset() = 0;
  virtual void setAccessoryOff(const std::string &accessoryId) = 0;
  virtual void stop() = 0;
};

std::unique_ptr<MatterRuntime> create_worker_matter_runtime(std::string storagePath);
std::unique_ptr<MatterRuntime> create_chip_process_matter_runtime(std::string storagePath);
std::unique_ptr<MatterRuntime> create_matter_runtime(std::string storagePath);