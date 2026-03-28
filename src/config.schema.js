import { z } from 'zod';

export const ConfigSchema = z.object({
    credentials: z.object({
        accessKey: z.string().min(1, "accessKey is required (check .env or config)"),
        secretKey: z.string().min(1, "secretKey is required (check .env or config)"),
    }).optional(),
    settings: z.object({
        maxConcurrent: z.number().int().positive().default(3),
        previewSamples: z.number().int().positive().default(25),
        previewTileSize: z.number().int().min(64).max(1024).default(280),
    }).default({}),
    models: z.array(z.object({
        name: z.string().min(1, "Model name is required"),
        url: z.url("Invalid Onshape URL"),
        formats: z.array(z.string()).min(1, "At least one format required"),
        propSets: z.array(z.looseObject({})).default([]),
        permutations: z.array(z.object({
            name: z.string().optional(),
            props: z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()])))
        })).optional(),
        rotation: z.object({
            x: z.number().optional(),
            y: z.number().optional(),
            z: z.number().optional(),
        }).optional(),
        translation: z.object({
            x: z.number().optional(),
            y: z.number().optional(),
            z: z.number().optional(),
        }).optional(),
        style: z.object({
            color: z.string().optional(),
            metalness: z.number().min(0).max(1).optional(),
            roughness: z.number().min(0).max(1).optional(),
            emissive: z.string().optional(),
            emissiveIntensity: z.number().optional(),
        }).optional(),
    })).default([]),
});

