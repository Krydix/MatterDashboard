#pragma once

#include <string>
#include <vector>

struct KioskTarget {
  std::string id;
  std::string name;
  std::string url;
  int durationSeconds = 30;
  bool enabled = true;
};

struct MatterStatus {
  bool started = false;
  bool paired = false;
  std::string qrCode;
  std::string manualPairingCode;
};