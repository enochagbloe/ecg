# ECG Energy Monitoring System

Real-time electricity consumption monitoring with WebSocket streaming and MongoDB storage.

## Features

- ⚡ **Real-time monitoring** via WebSocket
- 📊 **Live dashboard** showing pulses, energy (kWh), and power (kW)
- 💾 **MongoDB storage** with automatic data persistence
- 🔌 **Serial port integration** for Arduino/ECG meter
- 📈 **Energy calculation** (1600 pulses = 1 kWh)

## Tech Stack

- **Frontend**: Next.js 16, React 19, Tailwind CSS
- **Backend**: Node.js, Socket.io
- **Database**: MongoDB with Mongoose
- **Hardware**: SerialPort (COM3 @ 9600 baud)

## Setup

### 1. Environment Variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Update with your MongoDB URI:

```env
MONGODB_URI=mongodb://localhost:27017/ecg-monitoring
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start MongoDB

Make sure MongoDB is running on your system.

### 4. Run Development Server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the dashboard.

## How It Works

### Data Flow

1. **Arduino/Meter** → Sends "1" pulses via serial port (COM3)
2. **ECGMonitor Class** → Counts pulses and calculates energy/power
3. **WebSocket** → Broadcasts real-time data to connected clients
4. **Frontend** → Displays live metrics on dashboard
5. **MongoDB** → Stores data every 60 seconds

### Energy Calculations

- **Energy (kWh)** = pulses / 1600
- **Power (kW)** = Energy (kWh) / Duration (hours)

## Project Structure

```
ecg-pro/
├── app/
│   ├── components/
│   │   └── ECGMonitor.tsx    # Real-time dashboard UI
│   ├── page.tsx               # Main page
│   └── layout.tsx
├── server/
│   ├── index.ts               # Custom Next.js server
│   └── socketServer.ts        # Socket.io configuration
├── injest/
│   ├── ecg_plot.ts            # Serial port reader + WebSocket emitter
│   └── processor/
│       └── ecgProcessor.ts    # Energy/power calculation functions
├── database/
│   ├── ecg.model.ts           # Mongoose schema
│   └── index.ts
└── libs/
    ├── mongoose.ts            # DB connection manager
    └── logger.ts              # Pino logger
```

## API Events

### WebSocket Events

**Client → Server:**
- `connect` - Client connected
- `disconnect` - Client disconnected

**Server → Client:**
- `pulseData` - Emitted on every pulse detection
  ```typescript
  {
    pulseCount: number,
    timestamp: Date,
    energyKWh: number,
    powerKw: number
  }
  ```

## Database Schema

**ECGData Collection:**

```typescript
{
  timestamp: Date,      // When reading was taken
  pulses: Number,       // Total pulse count
  energyKwh: Number,    // Calculated energy in kWh
  powerKw: Number,      // Calculated power in kW
  createdAt: Date,      // Auto-generated
  updatedAt: Date       // Auto-generated
}
```

## Configuration

### Serial Port Settings

Edit `injest/ecg_plot.ts`:

```typescript
const monitor = new ECGMonitor("COM3", 9600);
```

### Database Sync Interval

Default: 60 seconds. Modify in `ecg_plot.ts`:

```typescript
const SAVE_INTERVAL = 60000; // milliseconds
```

## Troubleshooting

### Serial Port Not Found

1. Check device is connected
2. Verify COM port: Device Manager → Ports (COM & LPT)
3. Update port in code if needed

### MongoDB Connection Error

```bash
# Check MongoDB is running
mongosh

# If not installed, download from mongodb.com
```

### WebSocket Not Connecting

- Ensure custom server is running (not `next dev`)
- Check `NEXT_PUBLIC_SOCKET_URL` in `.env.local`
- Verify port 3000 is not blocked by firewall

## Production Deployment

```bash
npm run build
npm start
```

## License

MIT
