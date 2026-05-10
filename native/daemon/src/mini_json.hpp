#pragma once

#include <cctype>
#include <cmath>
#include <cstddef>
#include <cstdlib>
#include <map>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace mkjson {

class JsonValue {
 public:
  using Array = std::vector<JsonValue>;
  using Object = std::map<std::string, JsonValue>;

  JsonValue() : data_(nullptr) {}
  JsonValue(std::nullptr_t) : data_(nullptr) {}
  JsonValue(bool value) : data_(value) {}
  JsonValue(int value) : data_(static_cast<double>(value)) {}
  JsonValue(double value) : data_(value) {}
  JsonValue(std::string value) : data_(std::move(value)) {}
  JsonValue(const char *value) : data_(std::string(value)) {}
  JsonValue(Array value) : data_(std::make_shared<Array>(std::move(value))) {}
  JsonValue(Object value) : data_(std::make_shared<Object>(std::move(value))) {}

  [[nodiscard]] bool is_null() const { return std::holds_alternative<std::nullptr_t>(data_); }
  [[nodiscard]] bool is_bool() const { return std::holds_alternative<bool>(data_); }
  [[nodiscard]] bool is_number() const { return std::holds_alternative<double>(data_); }
  [[nodiscard]] bool is_string() const { return std::holds_alternative<std::string>(data_); }
  [[nodiscard]] bool is_array() const { return std::holds_alternative<ArrayPtr>(data_); }
  [[nodiscard]] bool is_object() const { return std::holds_alternative<ObjectPtr>(data_); }

  [[nodiscard]] bool as_bool() const {
    if (!is_bool()) {
      throw std::runtime_error("JSON value is not a bool");
    }
    return std::get<bool>(data_);
  }

  [[nodiscard]] double as_number() const {
    if (!is_number()) {
      throw std::runtime_error("JSON value is not a number");
    }
    return std::get<double>(data_);
  }

  [[nodiscard]] const std::string &as_string() const {
    if (!is_string()) {
      throw std::runtime_error("JSON value is not a string");
    }
    return std::get<std::string>(data_);
  }

  [[nodiscard]] const Array &as_array() const {
    if (!is_array()) {
      throw std::runtime_error("JSON value is not an array");
    }
    return *std::get<ArrayPtr>(data_);
  }

  [[nodiscard]] const Object &as_object() const {
    if (!is_object()) {
      throw std::runtime_error("JSON value is not an object");
    }
    return *std::get<ObjectPtr>(data_);
  }

  [[nodiscard]] Array &as_array() {
    if (!is_array()) {
      throw std::runtime_error("JSON value is not an array");
    }
    return *std::get<ArrayPtr>(data_);
  }

  [[nodiscard]] Object &as_object() {
    if (!is_object()) {
      throw std::runtime_error("JSON value is not an object");
    }
    return *std::get<ObjectPtr>(data_);
  }

  [[nodiscard]] const JsonValue *find(std::string_view key) const {
    if (!is_object()) {
      return nullptr;
    }

    const auto &object = as_object();
    const auto it = object.find(std::string(key));
    if (it == object.end()) {
      return nullptr;
    }

    return &it->second;
  }

 private:
  using ArrayPtr = std::shared_ptr<Array>;
  using ObjectPtr = std::shared_ptr<Object>;
  std::variant<std::nullptr_t, bool, double, std::string, ArrayPtr, ObjectPtr> data_;
};

class Parser {
 public:
  explicit Parser(std::string_view input) : input_(input) {}

  [[nodiscard]] JsonValue parse() {
    skip_whitespace();
    JsonValue value = parse_value();
    skip_whitespace();
    if (index_ != input_.size()) {
      throw std::runtime_error("Unexpected trailing JSON content");
    }
    return value;
  }

 private:
  [[nodiscard]] JsonValue parse_value() {
    if (index_ >= input_.size()) {
      throw std::runtime_error("Unexpected end of JSON input");
    }

    switch (input_[index_]) {
      case '{':
        return parse_object();
      case '[':
        return parse_array();
      case '"':
        return JsonValue(parse_string());
      case 't':
        consume_literal("true");
        return JsonValue(true);
      case 'f':
        consume_literal("false");
        return JsonValue(false);
      case 'n':
        consume_literal("null");
        return JsonValue(nullptr);
      default:
        return JsonValue(parse_number());
    }
  }

  [[nodiscard]] JsonValue parse_object() {
    expect('{');
    JsonValue::Object object;
    skip_whitespace();

    if (peek('}')) {
      expect('}');
      return JsonValue(std::move(object));
    }

    while (true) {
      skip_whitespace();
      const std::string key = parse_string();
      skip_whitespace();
      expect(':');
      skip_whitespace();
      object.emplace(key, parse_value());
      skip_whitespace();

      if (peek('}')) {
        expect('}');
        break;
      }

      expect(',');
    }

    return JsonValue(std::move(object));
  }

  [[nodiscard]] JsonValue parse_array() {
    expect('[');
    JsonValue::Array array;
    skip_whitespace();

    if (peek(']')) {
      expect(']');
      return JsonValue(std::move(array));
    }

    while (true) {
      skip_whitespace();
      array.push_back(parse_value());
      skip_whitespace();

      if (peek(']')) {
        expect(']');
        break;
      }

      expect(',');
    }

    return JsonValue(std::move(array));
  }

  [[nodiscard]] std::string parse_string() {
    expect('"');
    std::string result;

    while (index_ < input_.size()) {
      const char current = input_[index_++];
      if (current == '"') {
        return result;
      }

      if (current != '\\') {
        result.push_back(current);
        continue;
      }

      if (index_ >= input_.size()) {
        throw std::runtime_error("Invalid JSON escape sequence");
      }

      const char escaped = input_[index_++];
      switch (escaped) {
        case '"':
          result.push_back('"');
          break;
        case '\\':
          result.push_back('\\');
          break;
        case '/':
          result.push_back('/');
          break;
        case 'b':
          result.push_back('\b');
          break;
        case 'f':
          result.push_back('\f');
          break;
        case 'n':
          result.push_back('\n');
          break;
        case 'r':
          result.push_back('\r');
          break;
        case 't':
          result.push_back('\t');
          break;
        case 'u':
          if (index_ + 4 > input_.size()) {
            throw std::runtime_error("Invalid JSON unicode escape");
          }
          result.push_back('?');
          index_ += 4;
          break;
        default:
          throw std::runtime_error("Unsupported JSON escape sequence");
      }
    }

    throw std::runtime_error("Unterminated JSON string");
  }

  [[nodiscard]] double parse_number() {
    const std::size_t start = index_;
    if (peek('-')) {
      ++index_;
    }

    while (index_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[index_]))) {
      ++index_;
    }

    if (peek('.')) {
      ++index_;
      while (index_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[index_]))) {
        ++index_;
      }
    }

    if (peek('e') || peek('E')) {
      ++index_;
      if (peek('+') || peek('-')) {
        ++index_;
      }
      while (index_ < input_.size() && std::isdigit(static_cast<unsigned char>(input_[index_]))) {
        ++index_;
      }
    }

    const std::string number = std::string(input_.substr(start, index_ - start));
    char *end = nullptr;
    const double value = std::strtod(number.c_str(), &end);
    if (!end || *end != '\0') {
      throw std::runtime_error("Invalid JSON number");
    }
    return value;
  }

  void consume_literal(std::string_view literal) {
    if (input_.substr(index_, literal.size()) != literal) {
      throw std::runtime_error("Invalid JSON literal");
    }
    index_ += literal.size();
  }

  void skip_whitespace() {
    while (index_ < input_.size() && std::isspace(static_cast<unsigned char>(input_[index_]))) {
      ++index_;
    }
  }

  void expect(char expected) {
    if (index_ >= input_.size() || input_[index_] != expected) {
      throw std::runtime_error("Unexpected JSON token");
    }
    ++index_;
  }

  [[nodiscard]] bool peek(char expected) const {
    return index_ < input_.size() && input_[index_] == expected;
  }

  std::string_view input_;
  std::size_t index_ = 0;
};

inline JsonValue parse(std::string_view input) {
  return Parser(input).parse();
}

inline std::string escape(const std::string &value) {
  std::string result;
  result.reserve(value.size() + 8);

  for (const char current : value) {
    switch (current) {
      case '"':
        result += "\\\"";
        break;
      case '\\':
        result += "\\\\";
        break;
      case '\b':
        result += "\\b";
        break;
      case '\f':
        result += "\\f";
        break;
      case '\n':
        result += "\\n";
        break;
      case '\r':
        result += "\\r";
        break;
      case '\t':
        result += "\\t";
        break;
      default:
        result.push_back(current);
        break;
    }
  }

  return result;
}

inline std::string stringify(const JsonValue &value) {
  if (value.is_null()) {
    return "null";
  }

  if (value.is_bool()) {
    return value.as_bool() ? "true" : "false";
  }

  if (value.is_number()) {
    const double number = value.as_number();
    if (std::floor(number) == number) {
      return std::to_string(static_cast<long long>(number));
    }

    std::ostringstream stream;
    stream << number;
    return stream.str();
  }

  if (value.is_string()) {
    return std::string("\"") + escape(value.as_string()) + "\"";
  }

  if (value.is_array()) {
    std::string result = "[";
    bool first = true;
    for (const auto &entry : value.as_array()) {
      if (!first) {
        result.push_back(',');
      }
      first = false;
      result += stringify(entry);
    }
    result.push_back(']');
    return result;
  }

  std::string result = "{";
  bool first = true;
  for (const auto &[key, entry] : value.as_object()) {
    if (!first) {
      result.push_back(',');
    }
    first = false;
    result += std::string("\"") + escape(key) + "\":" + stringify(entry);
  }
  result.push_back('}');
  return result;
}

}  // namespace mkjson