#!/usr/bin/env bun
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import readline from 'node:readline';
import { ConfigSchema } from './config.schema.js';
import { convertTo3MF, convertToSTEP } from './converter.js';
import { generatePreview } from './preview_generator.js';
import prompts from 'prompts';

/**
 * Onshape Exporter CLI
 * Tidy, fast, and parallelized using Bun.
 */

const verbose = process.env.LOG_LEVEL === 'silly';
let currentStatusText = "";
let hasPython = false;

async function loadConfig() {
    const jsonPath = path.join(process.cwd(), 'config.json');
    const jsPath = path.join(process.cwd(), 'config.js');
    const permsPath = path.join(process.cwd(), 'config.permutations.json');

    // MIGRATION ROUTINE
    if (!fs.existsSync(jsonPath) && fs.existsSync(jsPath)) {
        console.log("🔄 Migrating old config.js to new config.json system...");
        const module = await import(jsPath);
        let migratedConfig = module.default || module;
        
        // Wipe hardcoded credentials from the migrated file to encourage .env usage
        migratedConfig.credentials = {};

        if (fs.existsSync(permsPath)) {
            try {
                const perms = JSON.parse(fs.readFileSync(permsPath, 'utf8'));
                if (migratedConfig.models) {
                    migratedConfig.models = migratedConfig.models.map(m => {
                        if (perms[m.name] && Array.isArray(perms[m.name])) {
                            return { ...m, propSets: perms[m.name] };
                        }
                        return m;
                    });
                }
                if (perms._addedModels && Array.isArray(perms._addedModels)) {
                    migratedConfig.models.push(...perms._addedModels);
                }
            } catch (e) {
                console.error("⚠️ Failed to parse config.permutations.json during migration.");
            }
        }

        fs.writeFileSync(jsonPath, JSON.stringify(migratedConfig, null, 2));
        fs.renameSync(jsPath, jsPath + '.bak');
        if (fs.existsSync(permsPath)) fs.rmSync(permsPath);
        console.log("✅ Migration complete! config.js is backed up as config.js.bak.\n");
    }

    if (!fs.existsSync(jsonPath)) {
        // Create an empty default template if completely missing
        const defaultTemplate = {
            settings: { maxConcurrent: 3 },
            credentials: {},
            models: []
        };
        fs.writeFileSync(jsonPath, JSON.stringify(defaultTemplate, null, 2));
        console.log("⚠️ Created a new empty config.json file.\n");
    }

    let rawConfig = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    // Merge credentials from .env
    rawConfig.credentials = rawConfig.credentials || {};
    rawConfig.credentials.accessKey = rawConfig.credentials.accessKey || process.env.ONSHAPE_ACCESS_KEY;
    rawConfig.credentials.secretKey = rawConfig.credentials.secretKey || process.env.ONSHAPE_SECRET_KEY;

    const result = ConfigSchema.safeParse(rawConfig);
    if (!result.success) {
        console.error("\n❌ Configuration Error:");
        result.error.issues.forEach(issue => console.error(`   - ${issue.path.join('.')}: ${issue.message}`));
        process.exit(1);
    }
    return result.data;
}

function saveConfig(configData) {
    const jsonPath = path.join(process.cwd(), 'config.json');
    // Strip runtime credentials before saving
    const toSave = { ...configData, credentials: {} };
    fs.writeFileSync(jsonPath, JSON.stringify(toSave, null, 2));
}

function getHeaders(config, method, url, contentType = 'application/json') {
    const { accessKey, secretKey } = config.credentials;
    const parsedUrl = new URL(url);
    const nonce = crypto.randomBytes(25).toString('hex').substring(0, 25);
    const date = new Date().toUTCString();
    
    const sigContentType = method.toUpperCase() === 'GET' ? '' : contentType;
    const query = parsedUrl.search ? parsedUrl.search.substring(1) : '';
    const pathname = parsedUrl.pathname;
    
    const authString = (method + '\n' + nonce + '\n' + date + '\n' + sigContentType + '\n' + pathname + '\n' + query + '\n').toLowerCase();
    const signature = crypto.createHmac('sha256', secretKey).update(authString).digest('base64');

    const headers = {
        'Authorization': `On ${accessKey}:HmacSHA256:${signature}`,
        'Date': date,
        'On-Nonce': nonce,
        'Accept': 'application/json'
    };

    if (sigContentType) headers['Content-Type'] = sigContentType;
    return headers;
}

async function fetchModelConfiguration(config, model) {
    const parts = model.url.split('/');
    const [did, wid, eid] = [parts[4], parts[6], parts[8]];
    const apiUrl = `https://cad.onshape.com/api/elements/d/${did}/w/${wid}/e/${eid}/configuration`;
    
    const res = await fetch(apiUrl, { 
        headers: getHeaders(config, 'GET', apiUrl, 'application/vnd.onshape.v1+json') 
    });
    
    if (!res.ok) throw new Error(`Failed to fetch configuration: ${res.status} ${await res.text()}`);
    return await res.json();
}

async function exportVariation(config, model, format, props) {
    const filePath = getFilePath(model, format, props);

    if (fs.existsSync(filePath)) {
        if (verbose) console.log(`⏩ [${format}] Skipping: ${path.basename(filePath)}`);
        return filePath;
    }

    const targetDir = path.dirname(filePath);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    // Local Format Handling (Try local first, then fallback to Cloud)
    if (format === '3MF' || format === 'STEP') {
        const stlPath = await exportVariation(config, model, 'STL', props);
        if (stlPath) {
            try {
                if (verbose) console.log(`🔄 [${format}] Attempting Local Conversion: ${path.basename(filePath)}`);
                currentStatusText = `${format} (Local): ${path.basename(filePath)}`;
                if (format === '3MF') await convertTo3MF(stlPath, filePath);
                if (format === 'STEP') await convertToSTEP(stlPath, filePath);
                return filePath;
            } catch (err) {
                // If local failed, we fall through to the Cloud translation below.
                console.log(`\n   \x1b[33m⚠️  Local conversion failed for ${path.basename(filePath)}. Falling back to Cloud API...\x1b[0m`);
                if (verbose) console.log(`⚠️ [${format}] Local fallback error: ${err.message}`);
                currentStatusText = `Falling back to Cloud: ${path.basename(filePath)}`;
            }
        }
    }

    const parts = model.url.split('/');
    const [did, wid, eid] = [parts[4], parts[6], parts[8]];
    
    const entries = Object.entries(props);
    const configStr = entries.map(([k, v]) => `${k}=${String(v).replace(/ /g, '+')}`).join(';');
    const propsFileNamePart = entries.map(([k, v]) => `${k}_${String(v).replace(/ /g, '-')}`).join('_').replace(/[&=;]/g, '_');
    const fileName = `${model.name}_${propsFileNamePart}`;
    currentStatusText = `${format}: ${fileName}`;

    const apiUrl = `https://cad.onshape.com/api/partstudios/d/${did}/w/${wid}/e/${eid}/translations`;
    
    try {
        // 1. Trigger Translation
        const triggerRes = await fetch(apiUrl, {
            method: 'POST',
            headers: getHeaders(config, 'POST', apiUrl),
            body: JSON.stringify({
                formatName: format,
                destinationName: `${model.name}_${propsFileNamePart}`,
                configuration: configStr,
                storeInDocument: false
            })
        });

        if (!triggerRes.ok) throw new Error(`Trigger failed (${triggerRes.status}): ${await triggerRes.text()}`);

        const job = await triggerRes.json();
        const translationId = job.id;

        // 2. Poll Status
        let status = 'ACTIVE';
        let externalDataId = '';

        while (status === 'ACTIVE') {
            await new Promise(r => setTimeout(r, 5000));
            const pollUrl = `https://cad.onshape.com/api/translations/${translationId}`;
            const pollRes = await fetch(pollUrl, { headers: getHeaders(config, 'GET', pollUrl) });
            const pollData = await pollRes.json();
            
            status = pollData.requestState;
            if (status === 'DONE') externalDataId = pollData.resultExternalDataIds[0];
            else if (status === 'FAILED') throw new Error(`Onshape Export Failed: ${pollData.failureReason}`);
        }

        // 3. Download Result
        if (externalDataId) {
            const dlUrl = `https://cad.onshape.com/api/documents/d/${did}/externaldata/${externalDataId}`;
            if (verbose) console.log(`⬇️ [${format}] Downloading: ${path.basename(filePath)}`);
            
            const dlRes = await fetch(dlUrl, {
                headers: { ...getHeaders(config, 'GET', dlUrl), 'Accept': 'application/octet-stream' }
            });

            if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status})`);
            
            await Bun.write(filePath, dlRes);
            if (verbose) console.log(`✅ [${format}] Saved: ${path.basename(filePath)}`);
            return filePath;
        }
    } catch (err) {
        console.error(`❌ [${format}] Error (${path.basename(filePath)}):`, err.message);
    }
    return null;
}

function expandPermutations(permutations) {
    const result = [];
    for (const group of permutations) {
        const keys = Object.keys(group.props);
        if (keys.length === 0) continue;
        const combos = [{}];
        for (const key of keys) {
            const expanded = [];
            for (const combo of combos) {
                for (const val of group.props[key]) {
                    expanded.push({ ...combo, [key]: val });
                }
            }
            combos.length = 0;
            combos.push(...expanded);
        }
        result.push(...combos);
    }
    return result;
}

function getFilePath(model, format, props) {
    const entries = Object.entries(props);
    const propsFileNamePart = entries.map(([k, v]) => `${k}_${String(v).replace(/ /g, '-')}`).join('_').replace(/[&=;]/g, '_');
    const targetDir = path.join(process.cwd(), 'dist', model.name, format);
    const ext = format.toLowerCase() === 'step' ? 'step' : format.toLowerCase();
    const fileName = `${model.name}_${propsFileNamePart}.${ext}`;
    return path.join(targetDir, fileName);
}

/**
 * Simple Concurrency Queue with Spinner and Status
 */
async function runWithLimit(tasks, limit, progressLabel = "Processing") {
    const results = [];
    const executing = new Set();
    let completed = 0;
    const total = tasks.length;
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let spinnerIdx = 0;

    const render = () => {
        const s = spinner[spinnerIdx];
        const status = currentStatusText ? ` \x1b[90m― ${currentStatusText.substring(0, 60)}${currentStatusText.length > 60 ? '...' : ''}\x1b[0m` : "";
        process.stdout.write(`\r   \x1b[35m${s}\x1b[0m \x1b[36m${progressLabel}: [${completed}/${total}]\x1b[0m${status}\x1b[K`);
    };

    const interval = setInterval(() => {
        spinnerIdx = (spinnerIdx + 1) % spinner.length;
        render();
    }, 80);

    for (const task of tasks) {
        const p = task().then(res => {
            executing.delete(p);
            completed++;
            render();
            return res;
        });
        results.push(p);
        executing.add(p);
        if (executing.size >= limit) {
            await Promise.race(executing);
        }
    }
    
    await Promise.all(results);
    clearInterval(interval);
    process.stdout.write(`\r   \x1b[32m✔\x1b[0m \x1b[36m${progressLabel}: [${total}/${total}] Complete!\x1b[0m${' '.repeat(80)}\n`);
    currentStatusText = "";
    return results;
}

async function bulkConvert(folderPath, targetFormats = ['STEP', '3MF']) {
    if (!fs.existsSync(folderPath)) {
        console.error(`❌ Folder not found: ${folderPath}`);
        return;
    }

    const files = fs.readdirSync(folderPath).filter(f => f.toLowerCase().endsWith('.stl'));
    if (files.length === 0) {
        console.log(`⚠️ No STL files found in ${folderPath}`);
        return;
    }

    console.log(`\n🔄 Bulk converting ${files.length} STL files to ${targetFormats.join(' & ')}...\n`);
    
    // Create target directories if they don't exist
    const baseDir = path.dirname(folderPath); // Assuming STL folder is inside model name folder
    const targetDirs = {};
    for (const fmt of targetFormats) {
        const dir = path.join(baseDir, fmt);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        targetDirs[fmt] = dir;
    }

    const tasks = [];
    for (const file of files) {
        const stlPath = path.join(folderPath, file);
        for (const fmt of targetFormats) {
            const ext = fmt.toLowerCase() === 'step' ? 'step' : fmt.toLowerCase();
            const outPath = path.join(targetDirs[fmt], file.replace(/\.stl$/i, `.${ext}`));
            
            if (fs.existsSync(outPath)) {
                if (verbose) console.log(`⏩ [${fmt}] Skipping (exists): ${path.basename(outPath)}`);
                continue;
            }

            tasks.push(async () => {
                try {
                    if (fmt === 'STEP') await convertToSTEP(stlPath, outPath);
                    if (fmt === '3MF') await convertTo3MF(stlPath, outPath);
                } catch (err) {
                    console.error(`❌ [${fmt}] Failed conversion for ${file}:`, err.message);
                }
            });
        }
    }

    if (tasks.length === 0) {
        console.log("✅ All files already converted.");
        return;
    }

    // Use concurrency limit from config if possible, else default to 3
    let limit = 3;
    try {
        const config = await loadConfig();
        limit = config.settings.maxConcurrent;
    } catch(e) {}

    await runWithLimit(tasks, limit, "Converting");
    console.log(`\n✨ Bulk conversion complete!`);
}

async function spawnPreview(folderPath, rotation = "{}", translation = "{}", style = "{}", maxSamples = 25, tileSize = 280) {
    try {
        await generatePreview(folderPath, rotation, translation, style, maxSamples, tileSize);
    } catch (err) {
        console.error(`❌ Preview generation failed for ${folderPath}:`, err.message);
    }
}

function buildExportSummary(selected) {
    const rows = [];
    let grandTotal = 0;
    let grandExisting = 0;
    let grandApiCalls = 0;

    for (const model of selected) {
        const permutationSets = model.permutations ? expandPermutations(model.permutations) : [];
        const effectivePropSets = [...(model.propSets || []), ...permutationSets];
        if (effectivePropSets.length === 0) continue;

        let modelTotal = 0;
        let modelExisting = 0;
        let modelApiCalls = 0;

        for (const props of effectivePropSets) {
            let needsStl = false;
            for (const format of model.formats) {
                modelTotal++;
                const exists = fs.existsSync(getFilePath(model, format, props));
                if (exists) modelExisting++;
                else {
                    if ((format === '3MF' || format === 'STEP') && hasPython) needsStl = true;
                    else modelApiCalls++;
                }
            }
            if (needsStl && !fs.existsSync(getFilePath(model, 'STL', props))) {
                // If we need a local conversion and STL doesn't exist, we'll need an API call for it
                // Note: If STL was already counted as an API call above, don't double count
                const stlInFormats = model.formats.includes('STL');
                if (!stlInFormats) modelApiCalls++;
            }
        }

        rows.push({ 
            name: model.name, 
            total: modelTotal, 
            existing: modelExisting, 
            combinations: effectivePropSets.length,
            apiCalls: modelApiCalls 
        });
        grandTotal += modelTotal;
        grandExisting += modelExisting;
        grandApiCalls += modelApiCalls;
    }

    return { rows, grandTotal, grandExisting, grandApiCalls };
}

async function handleExport(config, selected) {
    const tasks = [];
    for (const model of selected) {
        const localFormats = model.formats.filter(f => f === '3MF' || f === 'STEP');
        const remoteFormats = model.formats.filter(f => f !== '3MF' && f !== 'STEP');

        const permutationSets = model.permutations ? expandPermutations(model.permutations) : [];
        const effectivePropSets = [...(model.propSets || []), ...permutationSets];
        if (effectivePropSets.length === 0) {
            console.log(`⚠️ [${model.name}] No propSets or permutations configured. Use ⚙️  Permutations to set up export combinations.`);
            continue;
        }
        for (const props of effectivePropSets) {
            if (localFormats.length > 0 || model.formats.includes('STL')) {
                tasks.push(async () => {
                    const stlPath = await exportVariation(config, model, 'STL', props);
                    if (!stlPath) return;
                    for (const fmt of localFormats) {
                        await exportVariation(config, model, fmt, props);
                    }
                });
            }
            for (const format of remoteFormats) {
                if (format === 'STL') continue;
                tasks.push(() => exportVariation(config, model, format, props));
            }
        }
    }

    console.log(`\n🚀 Starting ${tasks.length} exports (Parallel: ${config.settings.maxConcurrent})...\n`);
    const start = Date.now();
    await runWithLimit(tasks, config.settings.maxConcurrent, "Exporting");
    console.log(`\n✨ Export complete! Total time: ${((Date.now() - start) / 1000).toFixed(1)}s`);

    console.log(`\n🎨 Generating previews for exported models...\n`);
    for (const model of selected) {
        if (model.formats.includes("STL")) {
            const folderPath = path.join(process.cwd(), 'dist', model.name, 'STL');
            if (fs.existsSync(folderPath)) {
                console.log(`\n➡️ Generating preview for: ${model.name}`);
                const rotation = model.rotation ? JSON.stringify(model.rotation) : "{}";
                const translation = model.translation ? JSON.stringify(model.translation) : "{}";
                const style = model.style ? JSON.stringify(model.style) : "{}";
                await spawnPreview(folderPath, rotation, translation, style, config.settings.previewSamples, config.settings.previewTileSize);
            }
        }
    }
}

async function handlePermutations(currentConfig, model) {
    console.log(`\n🔄 Fetching configuration schema from Onshape for ${model.name}...`);
    let apiConfig;
    try {
        apiConfig = await fetchModelConfiguration(currentConfig, model);
    } catch (e) {
        console.error("❌ " + e.message);
        return;
    }

    const params = apiConfig.configurationParameters;
    const collectedValues = {};
    
    console.log(`\n📝 Let's configure permutations. Enter comma-separated values.`);
    console.log(`   Leave empty or type 'IGNORE' (or 'i') to skip generating permutations for a parameter.\n`);

    for (const param of params) {
        const pId = param.message.parameterId;
        const pName = param.message.parameterName || pId;
        const typeName = param.typeName;

        let hint = "";
        let defaultValue = param.message.defaultValue || "";
        
        const fromPropSets = model.propSets ? model.propSets.map(p => p[pId]).filter(v => v !== undefined) : [];
        const fromPermutations = model.permutations ? model.permutations.flatMap(g => g.props[pId] || []) : [];
        const existingValues = [...new Set([...fromPropSets, ...fromPermutations])];
        if (existingValues.length > 0) hint = ` (Current: ${existingValues.join(', ')})`;
        
        let promptConfig;

        if (typeName === 'BTMConfigurationParameterEnum') {
            const options = param.message.options.map(o => ({
                title: o.message.optionName || o.message.option,
                value: o.message.option,
                selected: existingValues.includes(o.message.option)
            }));
            
            promptConfig = {
                type: 'multiselect',
                name: 'input',
                message: `${pName} (Space to select, Enter to confirm. Select none to IGNORE):`,
                choices: options,
                min: 0
            };
        } else if (typeName === 'BTMConfigurationParameterBoolean') {
             promptConfig = {
                type: 'multiselect',
                name: 'input',
                message: `${pName} (Select values, or none to IGNORE):`,
                choices: [
                    { title: 'true', value: true, selected: existingValues.includes(true) },
                    { title: 'false', value: false, selected: existingValues.includes(false) }
                ],
                min: 0
            };
        } else {
             const defVal = param.message.rangeAndDefault?.message?.defaultValue;
             const units = param.message.rangeAndDefault?.message?.units === 'millimeter' ? 'mm' : '';
             if (defVal !== undefined) defaultValue = `${defVal}${units ? ' ' + units : ''}`;
             hint += ` (e.g., 20 mm, 30 mm)`;
             
             promptConfig = {
                type: 'text',
                name: 'input',
                message: `${pName}${hint}:`,
                initial: existingValues.join(', ') || defaultValue.toString()
            };
        }

        const { input } = await prompts(promptConfig);

        if (input === undefined) return; // Ctrl+C

        if (typeName === 'BTMConfigurationParameterEnum' || typeName === 'BTMConfigurationParameterBoolean') {
            if (!input || input.length === 0) {
                console.log(`   ⏭️  Ignoring ${pName}`);
                continue;
            }
            collectedValues[pId] = input;
        } else {
            const valObj = input.toString().trim();
            if (!valObj || valObj.toUpperCase() === 'IGNORE' || valObj.toUpperCase() === 'I') {
                console.log(`   ⏭️  Ignoring ${pName}`);
                continue;
            }
            const vals = valObj.split(',').map(v => v.trim()).filter(v => v !== '');
            if (vals.length > 0) collectedValues[pId] = vals;
        }
    }

    const paramKeys = Object.keys(collectedValues);
    if (paramKeys.length === 0) {
        console.log("⚠️ No parameters configured. Aborting format.");
        return;
    }

    // Parse string booleans in collected values
    for (const key of paramKeys) {
        collectedValues[key] = collectedValues[key].map(val => {
            if (typeof val === 'string') {
                if (val.toLowerCase() === 'true') return true;
                if (val.toLowerCase() === 'false') return false;
            }
            return val;
        });
    }

    const preview = expandPermutations([{ props: collectedValues }]);
    console.log(`\n✨ Generated ${preview.length} permutations.`);
    console.log("Preview of first 3 permutations:");
    preview.slice(0, 3).forEach(p => console.log(JSON.stringify(p)));
    if (preview.length > 3) console.log("...");

    const { save } = await prompts({
        type: 'confirm',
        name: 'save',
        message: `Save these ${preview.length} permutations to config.json?`,
        initial: true
    });

    if (save) {
        const modelObj = currentConfig.models.find(m => m.name === model.name);
        if (modelObj) {
            if (!modelObj.permutations) modelObj.permutations = [];
            const existingIdx = modelObj.permutations.findIndex(g => g.name === 'onshape');
            const group = { name: 'onshape', props: collectedValues };
            if (existingIdx >= 0) modelObj.permutations[existingIdx] = group;
            else modelObj.permutations.push(group);
            saveConfig(currentConfig);
            console.log(`✅ Saved config.json with updated permutations for ${model.name}`);
        } else {
            console.error(`❌ Could not find model ${model.name} in currentConfig to save permutations.`);
        }
    } else {
        console.log(`❌ Discarded permutations.`);
    }
}

async function handleAddModel(currentConfig) {
    console.log(`\n➕ Add New Model`);
    const response = await prompts([
        {
            type: 'text',
            name: 'name',
            message: 'Model Name (e.g., my-awesome-part):',
            validate: value => value.length > 0 ? true : 'Name is required'
        },
        {
            type: 'text',
            name: 'url',
            message: 'Onshape Document URL:',
            validate: value => value.includes('cad.onshape.com/documents') ? true : 'Must be a valid Onshape document URL'
        },
        {
            type: 'multiselect',
            name: 'formats',
            message: 'Select export formats:',
            choices: [
                { title: 'STL', value: 'STL', selected: true },
                { title: 'STEP', value: 'STEP', selected: true },
                { title: '3MF', value: '3MF', selected: true },
                { title: 'IGES', value: 'IGES' }
            ],
            min: 1
        }
    ]);

    if (!response.name || !response.url || !response.formats) {
        console.log("⚠️ Model creation cancelled.");
        return;
    }

    const newModel = {
        name: response.name,
        url: response.url,
        formats: response.formats,
        propSets: [],
        permutations: []
    };

    if (!currentConfig.models) currentConfig.models = [];
    currentConfig.models.push(newModel);
    saveConfig(currentConfig);
    
    console.log(`\n✅ Model '${newModel.name}' added! Use ⚙️  Permutations to configure export combinations.\n`);
}

async function handleAuthenticate() {
    const envPath = path.join(process.cwd(), '.env');
    const existing = fs.existsSync(envPath);

    console.log(`\n🔑 Onshape API Credentials`);
    console.log(`   Get your keys at: https://dev-portal.onshape.com/keys\n`);

    if (existing) {
        const { overwrite } = await prompts({
            type: 'confirm',
            name: 'overwrite',
            message: '.env already exists. Overwrite credentials?',
            initial: false
        });
        if (!overwrite) { console.log('⬅️  Cancelled.\n'); return; }
    }

    const creds = await prompts([
        {
            type: 'text',
            name: 'accessKey',
            message: 'Access Key:',
            validate: v => v.length > 0 ? true : 'Access key is required'
        },
        {
            type: 'password',
            name: 'secretKey',
            message: 'Secret Key:',
            validate: v => v.length > 0 ? true : 'Secret key is required'
        }
    ]);

    if (!creds.accessKey || !creds.secretKey) {
        console.log('\n⚠️  Cancelled.\n');
        return;
    }

    await Bun.write(envPath, `ONSHAPE_ACCESS_KEY=${creds.accessKey}\nONSHAPE_SECRET_KEY=${creds.secretKey}\n`);
    process.env.ONSHAPE_ACCESS_KEY = creds.accessKey;
    process.env.ONSHAPE_SECRET_KEY = creds.secretKey;
    console.log(`\n✅ Credentials saved to .env\n`);
}

async function handleEditModel(currentConfig, model) {
    console.log(`\n✏️  Edit Details for ${model.name}`);
    
    const style = model.style || { color: '#ffffff', metalness: 0, roughness: 0.5 };
    const trans = model.translation || { x: 0, y: 0, z: 0 };
    const rot = model.rotation || { x: 0, y: 0, z: 0 };

    const responses = await prompts([
        { type: 'text', name: 'color', message: 'Color (Hex):', initial: style.color },
        { type: 'number', name: 'metalness', message: 'Metalness (0 to 1):', initial: style.metalness, float: true, min: 0, max: 1 },
        { type: 'number', name: 'roughness', message: 'Roughness (0 to 1):', initial: style.roughness, float: true, min: 0, max: 1 },
        { type: 'text', name: 'transX', message: 'Translation X:', initial: trans.x.toString() },
        { type: 'text', name: 'transY', message: 'Translation Y:', initial: trans.y.toString() },
        { type: 'text', name: 'transZ', message: 'Translation Z:', initial: trans.z.toString() },
        { type: 'text', name: 'rotX', message: 'Rotation X (deg):', initial: rot.x.toString() },
        { type: 'text', name: 'rotY', message: 'Rotation Y (deg):', initial: rot.y.toString() },
        { type: 'text', name: 'rotZ', message: 'Rotation Z (deg):', initial: rot.z.toString() }
    ]);

    if (Object.keys(responses).length < 9) {
        console.log("⚠️ Edit cancelled.");
        return;
    }

    const modelObj = currentConfig.models.find(m => m.name === model.name);
    if (modelObj) {
        modelObj.style = {
            color: responses.color,
            metalness: responses.metalness,
            roughness: responses.roughness
        };
        modelObj.translation = {
            x: parseFloat(responses.transX) || 0,
            y: parseFloat(responses.transY) || 0,
            z: parseFloat(responses.transZ) || 0
        };
        modelObj.rotation = {
            x: parseFloat(responses.rotX) || 0,
            y: parseFloat(responses.rotY) || 0,
            z: parseFloat(responses.rotZ) || 0
        };
        saveConfig(currentConfig);
        console.log(`✅ Saved updated details for ${model.name}`);
    }
}

async function handleModelAction(config, selectedModel, action) {
    if (action === 'export') {
        const summary = buildExportSummary([selectedModel]);
        if (summary.grandTotal === 0) {
            console.log(`\n⚠️ No export combinations configured. Use ⚙️  Permutations first.\n`);
            return;
        }
        console.log(`\n📊 Export Preview for: ${selectedModel.name}`);
        console.log(`${'─'.repeat(60)}`);
        for (const row of summary.rows) {
            console.log(`   ${row.name}`);
            console.log(`     Variants (Combinations) : ${row.combinations}`);
            console.log(`     Onshape API Calls       : ${row.apiCalls} (Required downloads)`);
            console.log(`     Already exist           : ${row.existing} (will skip)`);
            console.log(`     Final Total Files       : ${row.total}`);
        }
        console.log(`${'─'.repeat(60)}`);
        const toExportTotal = summary.grandTotal - summary.grandExisting;
        const localConversions = toExportTotal - summary.grandApiCalls;
        console.log(`   🚀 Plan: ${summary.grandApiCalls} downloads + ${localConversions} local conversions → ${toExportTotal} new files`);
        console.log(`\x1b[90m   (Note: Local conversion is preferred for STEP/3MF. If it fails, we fall back to Cloud translation.)\x1b[0m\n`);

        const { confirm } = await prompts({
            type: 'confirm',
            name: 'confirm',
            message: `Start download and local conversion?`,
            initial: true
        });
        if (!confirm) { console.log('⬅️  Export cancelled.\n'); return; }
        await handleExport(config, [selectedModel]);
    } else if (action === 'convert') {
        const folderPath = path.join(process.cwd(), 'dist', selectedModel.name, 'STL');
        await bulkConvert(folderPath);
    } else if (action === 'preview') {
        const folderPath = path.join(process.cwd(), 'dist', selectedModel.name, 'STL');
        if (!fs.existsSync(folderPath)) {
            console.log(`\n❌ Error: No STLs found at ${folderPath}\n`);
            return;
        }
        const rotation = selectedModel.rotation ? JSON.stringify(selectedModel.rotation) : "{}";
        const translation = selectedModel.translation ? JSON.stringify(selectedModel.translation) : "{}";
        const style = selectedModel.style ? JSON.stringify(selectedModel.style) : "{}";
        await spawnPreview(folderPath, rotation, translation, style, config.settings.previewSamples, config.settings.previewTileSize);
    } else if (action === 'permutations') {
        await handlePermutations(config, selectedModel);
    } else if (action === 'delete') {
            const { confirmDelete } = await prompts({
                type: 'confirm',
                name: 'confirmDelete',
                message: `Are you sure you want to delete ${selectedModel.name} from config.json?`,
                initial: false
            });
            if (confirmDelete) {
                config.models = config.models.filter(m => m.name !== selectedModel.name);
                saveConfig(config);
                console.log(`\n🗑️  Deleted ${selectedModel.name}\n`);
                return 'deleted';
            }
    } else if (action === 'edit') {
            await handleEditModel(config, selectedModel);
    }
}

async function keypressMenu(title, choices, preselectedIdx = 0) {
    let selectedIdx = preselectedIdx;
    
    const render = () => {
        process.stdout.write('\x1Bc'); // Clear console
        console.log("\n╔══════════════════════════════════════════════════════╗");
        console.log("║           ONSHAPE MULTI-MODEL EXPORTER (BUN)         ║");
        console.log("╚══════════════════════════════════════════════════════╝\n");
        process.stdout.write(`  ${title}\n`);
        process.stdout.write(`  ${'─'.repeat(50)}\n`);
        choices.forEach((c, i) => {
            const isSelected = i === selectedIdx;
            const prefix = isSelected ? ' \x1b[32m>\x1b[0m ' : '   ';
            const label = isSelected ? `\x1b[1;32m${c.label}\x1b[0m` : c.label;
            process.stdout.write(`${prefix}${label}\n`);
        });
        process.stdout.write('\n');
    };

    render();

    return new Promise((resolve) => {
        const handleKeyPress = (s, key) => {
            if (key.ctrl && key.name === 'c') process.exit(0);

            if (key.name === 'up') {
                selectedIdx = (selectedIdx - 1 + choices.length) % choices.length;
                render();
            } else if (key.name === 'down') {
                selectedIdx = (selectedIdx + 1) % choices.length;
                render();
            } else if (key.name === 'return' || key.name === 'enter') {
                finish(choices[selectedIdx].value);
            } else if (key.sequence && key.sequence.length === 1) {
                const shortcuts = choices.map(c => c.key?.toLowerCase()).filter(Boolean);
                const char = key.sequence.toLowerCase();
                const idx = shortcuts.indexOf(char);
                if (idx !== -1) finish(choices[idx].value);
                else {
                  // Direct numerical key support for model numbers
                  const match = choices.find(c => c.key === char);
                  if (match) finish(match.value);
                }
            }
        };

        const finish = (val) => {
            process.stdin.removeListener('keypress', handleKeyPress);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            resolve(val);
        };

        readline.emitKeypressEvents(process.stdin);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('keypress', handleKeyPress);
    });
}

async function main() {
    process.stdout.write('\x1Bc'); // Clear console
    console.log("\n╔══════════════════════════════════════════════════════╗");
    console.log("║           ONSHAPE MULTI-MODEL EXPORTER (BUN)         ║");
    console.log("╚══════════════════════════════════════════════════════╝\n");

    const args = process.argv.slice(2);
    if (args.includes('--authenticate')) {
        await handleAuthenticate();
        process.exit(0);
    }

    const convertIdx = args.indexOf('--convert');
    if (convertIdx !== -1) {
        const folderPath = args[convertIdx + 1];
        if (!folderPath || folderPath.startsWith('--')) {
             console.error("\n❌ Error: Please provide a folder path after --convert");
             process.exit(1);
        }
        await bulkConvert(path.resolve(folderPath));
        process.exit(0);
    }

    const previewStringIdx = args.indexOf('--preview');
    if (previewStringIdx !== -1) {
        const folderPath = args[previewStringIdx + 1];
        if (!folderPath || folderPath.startsWith('--')) {
             console.error("\n❌ Error: Please provide a folder path after --preview");
             process.exit(1);
        }

        let rotation = "{}";
        let translation = "{}";
        let style = "{}";
        let maxSamples = 25;

        try {
            const config = await loadConfig();
            maxSamples = config.settings.previewSamples;
            const folderBase = path.basename(path.dirname(folderPath));
            const model = config.models.find(m => m.name === folderBase || folderPath.includes(m.name));

            if (model) {
                if (model.rotation) rotation = JSON.stringify(model.rotation);
                if (model.translation) translation = JSON.stringify(model.translation);
                if (model.style) style = JSON.stringify(model.style);
                console.log(`\n⚙️ Using config for model: ${model.name}`);
            }
        } catch (e) {
            console.log("\n⚠️ No matching model config found, using defaults.");
        }

        console.log(`\n🎨 Generating preview for: ${folderPath}...\n`);
        await spawnPreview(folderPath, rotation, translation, style, maxSamples, config?.settings?.previewTileSize ?? 280);
        process.exit(0);
    }

    // Handle Direct Command Argument (e.g. bun start 2 v)
    const posArgs = args.filter(a => !a.startsWith('--'));
    if (posArgs.length > 0) {
        const config = await loadConfig();
        const modelRef = posArgs[0];
        const actionKey = posArgs[1];
        
        const model = config.models.find((m, i) => String(i + 1) === modelRef || m.name === modelRef);
        if (model) {
            if (actionKey) {
                const actionMap = {
                    'e': 'export',
                    'c': 'convert',
                    'v': 'preview',
                    'p': 'permutations',
                    'd': 'edit',
                    'r': 'delete'
                };
                const action = actionMap[actionKey.toLowerCase()];
                if (action) {
                    await handleModelAction(config, model, action);
                    process.exit(0);
                } else {
                    console.error(`❌ Unknown action shortcut: ${actionKey}`);
                    process.exit(1);
                }
            } else {
                // If only model is specified, maybe we could preselect it in the loop, 
                // but for now let's just fall through to interactive mode.
            }
        } else if (modelRef) {
            console.error(`❌ Model not found: ${modelRef}`);
            process.exit(1);
        }
    }

    function checkPython() {
        try {
            const res = spawnSync('python', ['--version']);
            return res.status === 0;
        } catch {
            return false;
        }
    }
    hasPython = checkPython();

    // First-run credential wizard: prompt if no .env and no env vars are set
    const envPath = path.join(process.cwd(), '.env');
    if (!fs.existsSync(envPath) && !process.env.ONSHAPE_ACCESS_KEY) {
        console.log("👋 Welcome! Let's set up your Onshape API credentials.");
        console.log("   Get your keys at: https://dev-portal.onshape.com/keys\n");
        const creds = await prompts([
            { type: 'text', name: 'accessKey', message: 'Onshape Access Key:' },
            { type: 'password', name: 'secretKey', message: 'Onshape Secret Key:' },
        ]);
        if (creds.accessKey && creds.secretKey) {
            await Bun.write(envPath, `ONSHAPE_ACCESS_KEY=${creds.accessKey}\nONSHAPE_SECRET_KEY=${creds.secretKey}\n`);
            process.env.ONSHAPE_ACCESS_KEY = creds.accessKey;
            process.env.ONSHAPE_SECRET_KEY = creds.secretKey;
            console.log('\n✅ Credentials saved to .env\n');
        } else {
            console.log('\n⚠️  Skipped. You can add credentials to a .env file later.\n');
        }
    }

    while (true) {
        console.clear();
        console.log("\x1b[95m╔══════════════════════════════════════════════════════╗\x1b[0m");
        console.log("\x1b[95m║           ONSHAPE MULTI-MODEL EXPORTER (BUN)         ║\x1b[0m");
        console.log("\x1b[95m╚══════════════════════════════════════════════════════╝\x1b[0m");
        
        if (hasPython) {
            console.log("   \x1b[32m🚀 Turbo Mode Active\x1b[0m (Local Python conversion enabled)\n");
        } else {
            console.log("   \x1b[36m☁️  Standalone Mode Active\x1b[0m (Using Cloud Fallback conversion)\n");
        }

        const currentConfig = await loadConfig();

        // First use: skip the menu and go straight to adding a model
        if (currentConfig.models.length === 0) {
            console.log("📭 No models configured yet. Let's add your first one.\n");
            await handleAddModel(currentConfig);
            continue;
        }

        const pad = currentConfig.models.length.toString().length;
        const selectedModel = await keypressMenu('Select a model:', [
            ...currentConfig.models.map((m, i) => ({
                key: String(i + 1),
                label: `[${String(i + 1).padStart(pad)}]  🧩 ${m.name}`,
                value: m
            })),
            { key: '+', label: `[+]  ➕ Add New Model`,                    value: 'add'          },
            { key: 'k', label: `[K]  🔑 Authenticate (Onshape API Keys)`,  value: 'authenticate' },
            { key: 'x', label: `[X]  🚪 Exit`,                             value: 'exit'         },
        ]);

        if (!selectedModel || selectedModel === 'exit') break;

        if (selectedModel === 'add') {
            await handleAddModel(currentConfig);
            continue;
        }

        if (selectedModel === 'authenticate') {
            await handleAuthenticate();
            continue;
        }

        while (true) {
            const action = await keypressMenu(`🧩 ${selectedModel.name}`, [
                { key: 'e', label: '[E]  📦  Export      — Run jobs for all permutations',      value: 'export'        },
                { key: 'c', label: '[C]  🔄  Convert     — Batch convert local STLs to STEP/3MF', value: 'convert'     },
                { key: 'v', label: '[V]  🖼️   Preview     — Generate 5×5 grid visualization',   value: 'preview'       },
                { key: 'p', label: '[P]  ⚙️   Permutations — Fetch & configure combinations',    value: 'permutations'  },
                { key: 'd', label: '[D]  ✏️   Details      — Color, rotation, translation',      value: 'edit'          },
                { key: 'r', label: '[R]  🗑️   Remove       — Delete model from config',          value: 'delete'        },
                { key: 'b', label: '[B]  ⬅️   Back',                                             value: 'back'          },
            ]);

            if (action === 'back') break;
            const res = await handleModelAction(currentConfig, selectedModel, action);
            if (res === 'deleted') break;
        }
    }
}

main().catch(err => {
    console.error("\n💀 Critical Error:", err.message);
    process.exit(1);
});

