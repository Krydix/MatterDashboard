cmake_minimum_required(VERSION 3.20)

project(matterkiosk-daemon LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(
  MATTERKIOSK_CONNECTEDHOMEIP_ROOT
  "${CMAKE_CURRENT_SOURCE_DIR}/../../third_party/connectedhomeip"
  CACHE PATH
  "Path to a vendored connectedhomeip checkout"
)

set(MATTERKIOSK_HAVE_CONNECTEDHOMEIP OFF)
if(
  EXISTS "${MATTERKIOSK_CONNECTEDHOMEIP_ROOT}/examples/platform/linux/AppMain.h"
  OR EXISTS "${MATTERKIOSK_CONNECTEDHOMEIP_ROOT}/examples/platform/darwin"
)
  set(MATTERKIOSK_HAVE_CONNECTEDHOMEIP ON)
endif()

message(STATUS "MatterKiosk connectedhomeip root: ${MATTERKIOSK_CONNECTEDHOMEIP_ROOT}")
message(STATUS "MatterKiosk connectedhomeip available: ${MATTERKIOSK_HAVE_CONNECTEDHOMEIP}")

add_executable(matterkiosk-daemon
  src/main.cpp
  src/matter_chip_process_runtime.cpp
  src/matter_runtime_factory.cpp
  src/matter_worker_runtime.cpp
  src/volume_controller.cpp
)

target_include_directories(matterkiosk-daemon PRIVATE src)
target_compile_definitions(
  matterkiosk-daemon
  PRIVATE
    MATTERKIOSK_HAVE_CONNECTEDHOMEIP=$<BOOL:${MATTERKIOSK_HAVE_CONNECTEDHOMEIP}>
)

find_package(Threads REQUIRED)
target_link_libraries(matterkiosk-daemon PRIVATE Threads::Threads)