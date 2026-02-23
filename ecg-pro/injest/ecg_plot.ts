import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import dbConnect from "../libs/mongoose";
import ECGData from "../database/ecg.model";
import { pulseToEnergy, energyToPower } from "./processor/ecgProcessor";
import logger from "../libs/logger";
import { getIO } from "../server/socketServer";

interface PulseData {
  pulseCount: number;
  timestamp: Date;
  energyKWh: number;
  powerKw: number;
}

class ECGMonitor {
  private pulseCount = 0;
  private startTime = new Date();
  private port: SerialPort;
  private parser: ReadlineParser;

  constructor(portPath: string = "COM3", baudRate: number = 9600) {
    this.port = new SerialPort({ path: portPath, baudRate });
    this.parser = this.port.pipe(new ReadlineParser({ delimiter: "\n" }));
    this.setupListeners();
    this.startDatabaseSync();
    
    // Connect to database
    dbConnect().catch((err) => logger.error({ err }, "DB connection failed"));
  }

  private setupListeners() {
    this.parser.on("data", (data: string) => {
      if (data.trim() === "1") {
        this.pulseCount++;
        const pulseData = this.getPulseData();
        
        logger.info(`Pulse detected. Total: ${this.pulseCount}`);
        
        // Emit real-time data via WebSocket
        try {
          const io = getIO();
          io.emit("pulseData", pulseData);
        } catch (error) {
          // Socket not initialized yet, ignore
        }
      }
    });

    this.port.on("open", () => {
      logger.info("Serial port opened. Listening for pulses...");
    });

    this.port.on("error", (err: Error) => {
      logger.error({ err: err.message }, "Serial port error");
    });
  }

  private startDatabaseSync() {
    // Save to database every 60 seconds
    const SAVE_INTERVAL = 60000; // 1 minute
    setInterval(async () => {
      if (this.pulseCount > 0) {
        const data = this.getPulseData();
        try {
          await ECGData.create({
            timestamp: data.timestamp,
            pulses: data.pulseCount,
            energyKwh: data.energyKWh,
            powerKw: data.powerKw,
          });
          logger.info(`Data saved: ${data.pulseCount} pulses, ${data.energyKWh.toFixed(3)} kWh, ${data.powerKw.toFixed(3)} kW`);
        } catch (error) {
          logger.error({ error }, "Failed to save data");
        }
      }
    }, SAVE_INTERVAL);
  }

  getPulseData(): PulseData {
    const durationHours = (Date.now() - this.startTime.getTime()) / (1000 * 60 * 60);
    const energyKWh = pulseToEnergy(this.pulseCount);
    const powerKw = energyToPower(this.pulseCount, durationHours);
    
    return {
      pulseCount: this.pulseCount,
      timestamp: new Date(),
      energyKWh,
      powerKw,
    };
  }

  reset() {
    this.pulseCount = 0;
    this.startTime = new Date();
  }
}

export default ECGMonitor;
