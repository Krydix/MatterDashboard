cmake_minimum_required(VERSION 3.20)

project(matterkiosk-daemon LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(matterkiosk-daemon
  src/main.cpp
)

target_include_directories(matterkiosk-daemon PRIVATE src)

find_package(Threads REQUIRED)
target_link_libraries(matterkiosk-daemon PRIVATE Threads::Threads)