#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct KioskTarget {
  std::string id;
  std::string name;
  std::string url;
  int durationSeconds = 30;
  bool enabled = true;
};

enum class MatterAccessoryKind {
  Dashboard,
  Volume,
};

enum class MatterAccessoryDeviceType {
  OnOffPlugInUnit,
  DimmableLight,
};

struct MatterAccessory {
  std::string id;
  std::string name;
  MatterAccessoryKind kind = MatterAccessoryKind::Dashboard;
  MatterAccessoryDeviceType deviceType = MatterAccessoryDeviceType::OnOffPlugInUnit;
  std::string url;
  int durationSeconds = 30;
  bool enabled = true;
  bool on = false;
  std::uint8_t level = 0;
};

struct VolumeControlConfig {
  bool enabled = false;
  std::string name = "Volume";
};

struct VolumeControlState {
  bool muted = false;
  int level = 50;
};

struct MatterStatus {
  bool started = false;
  bool paired = false;
  std::string qrCode;
  std::string manualPairingCode;
};