#pragma once

#include "daemon_types.hpp"

#include <memory>

class VolumeController {
 public:
  virtual ~VolumeController() = default;

  virtual bool isSupported() const = 0;
  virtual VolumeControlState getState() = 0;
  virtual void setMuted(bool muted) = 0;
  virtual void setLevel(int level) = 0;
};

std::unique_ptr<VolumeController> create_volume_controller();