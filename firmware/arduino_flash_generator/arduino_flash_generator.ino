/*
  ECG prototype bench test: 20 independent 20 ms red-LED flashes.
  Test light source ONLY. Upload to a SEPARATE Arduino Uno or ESP32,
  NOT to the ECG meter reader ESP32.
  Arduino Uno: D9 -> 220 ohm resistor -> LED anode; cathode -> GND.
  ESP32: GPIO25 -> 220 ohm resistor -> LED anode; cathode -> GND.
  Face LED towards TEPT4400; no shared wiring between the two boards.
*/
#include <Arduino.h>
#if defined(ARDUINO_ARCH_ESP32)
  constexpr int LED_PIN = 25;
#else
  constexpr int LED_PIN = 9;
#endif
constexpr int NUMBER_OF_FLASHES = 20;
constexpr unsigned long ON_TIME_MS = 20;
constexpr unsigned long OFF_TIME_MS = 800;

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  Serial.println("ECG LED CONTROLLED TEST: 20 x 20ms");
  Serial.println("Light source starts in 5 seconds...");
  delay(5000); // Observe five seconds of dark baseline on ECG dashboard.

  for (int n = 1; n <= NUMBER_OF_FLASHES; ++n) {
    digitalWrite(LED_PIN, HIGH);
    delay(ON_TIME_MS);
    digitalWrite(LED_PIN, LOW);
    Serial.print("Arduino flash ");
    Serial.print(n);
    Serial.print("/");
    Serial.println(NUMBER_OF_FLASHES);
    delay(OFF_TIME_MS);
  }
  Serial.println("FINISHED 20 FLASHES: LED OFF");
}

void loop() {
  // One controlled run per reset. Press Arduino RESET to repeat.
}
