const ECG_PULSES_PER_KWH = 1600; // Meter constant: 1600 pulses = 1 kWh

// Convert pulses to energy in kWh
export function pulseToEnergy(pulse: number): number {
    return pulse / ECG_PULSES_PER_KWH;
} 

// Convert pulses to average power in kW over a duration
export function energyToPower(pulse: number, duration_hour: number): number {
    if (duration_hour <= 0) return 0;
    return pulseToEnergy(pulse) / duration_hour;
}