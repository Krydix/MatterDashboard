#pragma once

#include "daemon_types.hpp"

#include <memory>

class BrightnessController {
 public:
  virtual ~BrightnessController() = default;

  virtual bool isSupported() const = 0;
  virtual BrightnessControlState getState(int displayId) = 0;
  virtual void setLevel(int displayId, int level) = 0;
};

std::unique_ptr<BrightnessController> create_brightness_controller();
