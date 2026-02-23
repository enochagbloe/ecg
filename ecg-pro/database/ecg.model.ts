import { Schema, model, models, Document } from "mongoose";


export interface IECGData {
    timestamp: Date;
    pulses: number;
    energyKwh: number;
    powerKw: number;
}

export interface IECGDataDoc extends IECGData, Document {}

const ECGDataSchema = new Schema<IECGDataDoc>(
    {
        timestamp: { type: Date, required: true, default: Date.now },
        pulses: { type: Number, required: true },
        energyKwh: { type: Number, required: true },
        powerKw: { type: Number, required: true },
    },
    {
        timestamps: true,
    }
);
export const ECGData = models.ECGData || model<IECGDataDoc>("ECGData", ECGDataSchema);

export default ECGData;