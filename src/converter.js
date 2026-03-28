import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

/**
 * Local Conversion Utilities using Python Helper
 */

function runConverter(format, stlPath, outputPath) {
    return new Promise((resolve, reject) => {
        // In dev mode, local_converter.py lives next to this source file.
        // In a compiled exe, import.meta.dir is an internal embedded path,
        // so we fall back to the directory containing the executable.
        const devPath = path.join(import.meta.dir, 'local_converter.py');
        const exePath = path.join(path.dirname(process.execPath), 'local_converter.py');
        const pythonScript = fs.existsSync(devPath) ? devPath : exePath;

        if (!fs.existsSync(pythonScript)) {
            return reject(new Error(
                `local_converter.py not found.\nExpected at: ${exePath}\n` +
                `Place local_converter.py next to the exe and run: pip install -r requirements.txt`
            ));
        }
        const verbose = process.env.LOG_LEVEL === 'silly';
        if (verbose) console.log(`🔄 [LOCAL] Converting to ${format.toUpperCase()}: ${path.basename(stlPath)} -> ${path.basename(outputPath)}`);
        
        const proc = spawn('python', [pythonScript, format, stlPath, outputPath]);

        let stderr = '';
        let stdout = '';
        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.on('close', (code) => {
            if (code === 0) {
                // Basic Validation
                try {
                    const stats = fs.statSync(outputPath);
                    if (stats.size === 0) throw new Error(`Generated ${format.toUpperCase()} file is empty.`);
                    
                    if (format === 'step') {
                        const content = fs.readFileSync(outputPath, 'utf8').substring(0, 100);
                        if (!content.includes('ISO-10303-21')) {
                            throw new Error("Generated file does not have a valid STEP header.");
                        }
                    }
                    
                    if (verbose) console.log(`✅ ${format.toUpperCase()} Conversion successful: ${path.basename(outputPath)}`);
                    resolve();
                } catch (err) {
                    reject(err);
                }
            } else {
                reject(new Error(`Python script exited with code ${code}.\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`));
            }
        });
    });
}

export async function convertTo3MF(stlPath, outputPath) {
    return runConverter('3mf', stlPath, outputPath);
}

export async function convertToSTEP(stlPath, outputPath) {
    return runConverter('step', stlPath, outputPath);
}
