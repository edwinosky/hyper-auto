// ----- DEPENDENCIAS -----
const playwright = require('playwright-extra');
const fs = require('fs').promises;
const ethers = require('ethers');
const { URL } = require('url');

// --- CONFIGURACIÓN ---
const API_BASE_URL = 'https://claim.hyperlane.foundation/api';
const TARGET_PAGE_URL = 'https://claim.hyperlane.foundation/'; // Navegaremos aquí
// *** AJUSTA ESTOS TIEMPOS SEGÚN TU EXPERIENCIA ***
const CHECK_INTERVAL = 30000;      // Intervalo base entre ciclos (30s)
const BASE_REQUEST_DELAY = 2000;   // Pausa base entre wallets seguras (1s)
const RANDOM_DELAY_MAX = 2500;     // Añadir hasta X ms aleatorios (1.5s)
const POST_ACTION_DELAY = 2000;    // Pausa adicional después de un POST (2s)
const MAX_RETRIES = 3;             // Reintentos en caso de error de red/servidor
const SECURE_WALLETS_FILE = 'secure.txt';
const ELIGIBLE_WALLETS_FILE = 'elegibles.txt';
const ASSIGNMENT_FILE = 'assignment.json'; // Fuente principal
const ANOMALY_REPORT_FILE = 'anomaly_report.txt';
const DEFAULT_CHAIN_ID = 8453;     // Base Mainnet
let TOKENS_PER_NETWORK = { chainId: DEFAULT_CHAIN_ID, tokenType: 'HYPER' };
const DEBUGGING_PORT = 9222;     // Puerto para conectar al navegador (ajusta si usas otro)

// --- Variables Globales ---
let browser; let context; let page;
const anomalyCounter = new Map();
let secureAddressToKey = new Map(); // Mapa global para acceso fácil

// --- Colores para Logs ---
const C_RESET = '\x1b[0m'; const C_RED = '\x1b[31m'; const C_GREEN = '\x1b[32m'; const C_YELLOW = '\x1b[33m'; const C_BLUE = '\x1b[34m'; const C_CYAN = '\x1b[36m';

// --- Variables para Delay Dinámico ---
let currentGlobalDelayFactor = 1.0;
const MAX_DELAY_FACTOR = 5.0;
const DELAY_FACTOR_INCREMENT = 1.5;
const DELAY_FACTOR_DECREMENT = 0.95;

// --- Funciones Auxiliares ---
const randomDelay = (baseMs = BASE_REQUEST_DELAY) => { const r = Math.floor(Math.random() * RANDOM_DELAY_MAX); const e = baseMs * currentGlobalDelayFactor; const t = Math.round(e + r); console.log(`${C_CYAN}[PAUSE]${C_RESET} Waiting ${(t / 1000).toFixed(1)}s (Factor: ${currentGlobalDelayFactor.toFixed(2)})...`); return new Promise(res => setTimeout(res, t)); };
function increaseGlobalDelay() { currentGlobalDelayFactor = Math.min(currentGlobalDelayFactor * DELAY_FACTOR_INCREMENT, MAX_DELAY_FACTOR); console.warn(`${C_YELLOW}[RATE_LIMIT_ADJUST]${C_RESET} Increasing delay factor to ${currentGlobalDelayFactor.toFixed(2)}`); }
function decreaseGlobalDelay() { if (currentGlobalDelayFactor > 1.0) { currentGlobalDelayFactor = Math.max(1.0, currentGlobalDelayFactor * DELAY_FACTOR_DECREMENT); } }
async function saveAnomalyReport() { const l = ['Anomaly Report', '================']; if (anomalyCounter.size === 0) { l.push('No anomalies.'); } else { for (const [a, c] of anomalyCounter) { l.push(`${a}: ${c} anomalies`); } } try { await fs.writeFile(ANOMALY_REPORT_FILE, l.join('\n')); console.log(`[INFO] Report updated: ${ANOMALY_REPORT_FILE}`); } catch (e) { console.error(`${C_RED}[ERROR]${C_RESET} Write report fail ${ANOMALY_REPORT_FILE}: ${e.message}`); } }
async function generateSignature(signer, eligibleAddress, receivingAddress, chainId, tokenType, amount) { const d = { name: 'Hyperlane', version: '1' }; const t = { Message: [{ name: 'eligibleAddress', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'amount', type: 'string' }, { name: 'receivingAddress', type: 'string' }, { name: 'tokenType', type: 'string' }] }; const m = { eligibleAddress: String(eligibleAddress).trim(), chainId: Number(chainId), amount: String(amount).trim(), receivingAddress: String(receivingAddress).trim(), tokenType: String(tokenType).trim() }; try { return await signer.signTypedData(d, t, m); } catch (e) { console.error(`${C_RED}[ERROR_SIGN]${C_RESET} Sign fail ${eligibleAddress}->${receivingAddress}: ${e.message}`); throw e; } }
async function registerMissingOrIncorrectWallets(securePrivateKey, walletsToRegister) { if (!walletsToRegister || walletsToRegister.length === 0) return true; const sw = new ethers.Wallet(securePrivateKey); const sa = sw.address; console.log(`[ACTION] Attempting to register group of ${walletsToRegister.length} wallets for ${sa.substring(0, 10)}...`); const success = await registerWalletGroup(sa, walletsToRegister); await randomDelay(POST_ACTION_DELAY); return success; }


// --- Carga de Datos ---
async function loadWalletsAndAssignment() {
    try {
        const secureKeysRaw = await fs.readFile(SECURE_WALLETS_FILE, 'utf8').then(c => c.split('\n'));
        const secureKeys = secureKeysRaw.map(l => { const t = l.trim(); if (!t) return null; const i = /^[0-9a-fA-F]+$/.test(t.startsWith('0x') ? t.substring(2) : t); const c = t.length === 64 || (t.startsWith('0x') && t.length === 66); if (!i || !c) { console.warn(`${C_YELLOW}[WARN] Invalid secure key ${SECURE_WALLETS_FILE}: "${t.substring(0, 10)}..." Skip.${C_RESET}`); return null; } return t.startsWith('0x') ? t : '0x' + t; }).filter(Boolean);
        if (secureKeys.length === 0) throw new Error(`No valid secure keys in ${SECURE_WALLETS_FILE}.`);

        const eligiblePrivKeysMap = new Map();
        const eligibleKeysRaw = await fs.readFile(ELIGIBLE_WALLETS_FILE, 'utf8').then(c => c.split('\n'));
        eligibleKeysRaw.forEach((line, index) => { const pk = line.trim(); if (pk && pk.startsWith('0x') && pk.length === 66) { try { const w = new ethers.Wallet(pk); eligiblePrivKeysMap.set(w.address.toLowerCase(), pk); } catch (e) { console.warn(`${C_YELLOW}[WARN] Invalid pk format ${ELIGIBLE_WALLETS_FILE} L${index + 1}. Skip.${C_RESET}`); } } else if (pk) { console.warn(`${C_YELLOW}[WARN] Invalid pk format/len ${ELIGIBLE_WALLETS_FILE} L${index + 1}. Skip.${C_RESET}`); } });
        if (eligiblePrivKeysMap.size === 0) throw new Error(`No valid private keys found in ${ELIGIBLE_WALLETS_FILE}.`);
        console.log(`[INFO] Loaded ${secureKeys.length} secure keys, ${eligiblePrivKeysMap.size} valid eligible private keys mapped.`);

        console.log(`[INFO] Loading assignment ${ASSIGNMENT_FILE}...`);
        let assignmentContent;
        try { assignmentContent = await fs.readFile(ASSIGNMENT_FILE, 'utf8'); } catch (e) { if (e.code === 'ENOENT') throw new Error(`${ASSIGNMENT_FILE} required, not found.`); else throw new Error(`Read ${ASSIGNMENT_FILE} fail: ${e.message}`); }
        const assignmentFromFile = JSON.parse(assignmentContent);

        secureAddressToKey.clear();
        secureKeys.forEach(k => { try { secureAddressToKey.set(new ethers.Wallet(k).address.toLowerCase(), k); } catch (e) { console.warn(`${C_YELLOW}[WARN] Failed processing secure key ${k.substring(0, 10)}... map: ${e.message}${C_RESET}`); } });
        console.log(`[DEBUG] Created secureAddressToKey map with ${secureAddressToKey.size} entries.`);
        if (secureAddressToKey.size === 0 && secureKeys.length > 0) { console.error(`${C_RED}[ERROR]${C_RESET} Secure address map empty despite keys. Check ${SECURE_WALLETS_FILE}.`); }

        const walletGroups = {}; let validEligibleCount = 0;
        for (const groupFromFile of assignmentFromFile) {
            const secureAddressLower = groupFromFile.secureAddress.toLowerCase();
            const secureKey = secureAddressToKey.get(secureAddressLower);
            if (!secureKey) { console.warn(`${C_YELLOW}[WARN] Skip group ${groupFromFile.secureAddress} from ${ASSIGNMENT_FILE} (key/addr not found)${C_RESET}`); continue; }
            walletGroups[secureKey] = [];
            for (const w of groupFromFile.eligibleWallets) {
                const eligibleAddrLower = w.address.toLowerCase();
                const privateKey = eligiblePrivKeysMap.get(eligibleAddrLower);
                if (!privateKey) { console.warn(`${C_YELLOW}[WARN] Skip eligible ${w.address} for ${groupFromFile.secureAddress} (No PK found)${C_RESET}`); continue; }
                const amountParsed = parseFloat(w.amount);
                if (isNaN(amountParsed)) { console.warn(`${C_YELLOW}[WARN] Invalid amount ${w.address} in ${ASSIGNMENT_FILE}: "${w.amount}". Skip.${C_RESET}`); continue; }
                const amount = amountParsed.toFixed(3);
                walletGroups[secureKey].push({ address: ethers.getAddress(w.address), privateKey: privateKey, amount: amount });
                validEligibleCount++;
            }
        }
        if (Object.keys(walletGroups).length === 0) throw new Error(`Could not form valid groups from ${ASSIGNMENT_FILE}. Check mapping.`);
        console.log(`[INFO] Assignment processed for ${Object.keys(walletGroups).length} secure wallets with ${validEligibleCount} total assigned.`);
        return { walletGroups, assignmentToShow: assignmentFromFile };
    } catch (error) { console.error(`${C_RED}[FATAL_LOAD]${C_RESET} Load data/assign fail: ${error.message}`); throw error; }
}

// --- Configuración Playwright (Conecta, Navega a TARGET_PAGE) ---
async function initializePlaywrightAndConfig() {
    console.log("[INFO] Configuring default ChainID...");
    TOKENS_PER_NETWORK.chainId = DEFAULT_CHAIN_ID;
    console.log(`[INFO] Default ChainId set to: ${DEFAULT_CHAIN_ID} (Base)`);
    console.warn(`${C_YELLOW}[ACTION REQUIRED] Ensure Chrome/Edge is running with:${C_RESET}`);
    console.warn(`${C_YELLOW}   --remote-debugging-port=${DEBUGGING_PORT}${C_RESET}`);
    console.warn(`${C_YELLOW}   --proxy-server="PROXY_URL" (IF USING A PROXY - RECOMMENDED!)${C_RESET}`);
    console.warn(`${C_YELLOW}   AND manually navigate a tab to ${TARGET_PAGE_URL} and ensure Vercel Checkpoint is passed (script will also try to navigate).${C_RESET}`);
    console.log(`[INFO] Attempting connection to port ${DEBUGGING_PORT}...`);
    try {
        browser = await playwright.chromium.connectOverCDP(`http://localhost:${DEBUGGING_PORT}`);
        console.log(`${C_GREEN}[INFO] Connected.${C_RESET}`);
        context = browser.contexts()[0]; if (!context) throw new Error("No default context."); console.log("[INFO] Using default context.");
        if (context.pages().length > 0) { page = context.pages()[0]; console.log("[INFO] Using existing tab handle."); }
        else { page = await context.newPage(); console.log("[INFO] Opened new tab handle."); }

        // *** NAVEGAR A LA PÁGINA OBJETIVO ***
        // Esto es necesario para que page.evaluate tenga el contexto correcto
        console.log(`[INFO] Navigating tab to ${TARGET_PAGE_URL} to set context for evaluate...`);
        try {
            await page.goto(TARGET_PAGE_URL, { waitUntil: 'networkidle', timeout: 60000 });
            console.log(`${C_GREEN}[INFO] Target page loaded/navigated in script.${C_RESET}`);
        } catch (gotoError) {
            console.warn(`${C_YELLOW}[WARN]${C_RESET} Script could not fully load ${TARGET_PAGE_URL} (${gotoError.message}). Ensure page is manually loaded and valid.`);
            // Continuamos de todas formas, confiando en la carga manual
        }
        // *** FIN NAVEGACIÓN ***

        await page.setViewportSize({ width: 1280, height: 800 });
        console.log(`${C_GREEN}[INFO] Setup complete. Ready to use page.evaluate.${C_RESET}`);
    } catch (error) { console.error(`${C_RED}[FATAL]${C_RESET} Connect/Setup fail port ${DEBUGGING_PORT}.`); console.error(`${C_RED}Error:${C_RESET} ${error.message}`); process.exit(1); }
}

// --- Llamadas API (Usando page.evaluate) ---
async function checkRegistrations(secureAddress, retryCount = 0) {
    const url = `${API_BASE_URL}/get-registration-for-address?address=${secureAddress}`;
    console.log(`[DEBUG] Checking GET (via evaluate): ${secureAddress.substring(0, 10)}...`);
    try {
        const args = { apiUrl: url, targetReferer: TARGET_PAGE_URL };
        const result = await page.evaluate(async (a) => { const { apiUrl, targetReferer } = a; try { const r = await fetch(apiUrl, { method: 'GET', headers: { 'Accept': 'application/json, text/plain, */*', 'Referer': targetReferer } }); const s = r.status; const b = await r.text(); return { status: s, body: b }; } catch (e) { return { error: `Fetch GET error in evaluate: ${e.message || String(e)}` }; } }, args);
        if (result.error) { console.error(`${C_RED}[ERROR_EVAL_GET]${C_RESET} Eval error ${secureAddress}: ${result.error}`); return null; } // Error LavaMoat suele ocurrir aquí
        const { status: s, body: b } = result; console.log(`[DEBUG] GET evaluate Response ${secureAddress.substring(0, 10)}... : Status ${s}`);
        if (s === 429) { console.warn(`${C_YELLOW}[RATE_LIMIT_GET]${C_RESET} Status 429 ${secureAddress}. Resp: ${b.substring(0, 300)}...`); increaseGlobalDelay(); await randomDelay(BASE_REQUEST_DELAY * 2); return null; }
        if (s === 403) { console.error(`${C_RED}[BLOCK_GET?]${C_RESET} Status 403 ${secureAddress}. Resp: ${b.substring(0, 500)}...`); return null; }
        if (s === 404) { console.log(`[DEBUG] GET ${secureAddress.substring(0, 10)}... 404 (None).`); return []; }
        if (s < 200 || s >= 300) { console.error(`${C_RED}[ERROR_API_GET]${C_RESET} Status ${s} ${secureAddress}. Resp: ${b.substring(0, 500)}...`); return null; }
        try { const d = JSON.parse(b); const c = d?.response?.length ?? 0; console.log(`[DEBUG] GET evaluate Success ${secureAddress.substring(0, 10)}... (${c} regs).`); return d?.response ?? []; }
        catch (p) { console.error(`${C_RED}[ERROR_PARSE_GET]${C_RESET} Parse fail (Status ${s}) ${secureAddress}: ${p.message}. Body: ${b.substring(0, 300)}...`); return null; }
    } catch (e) { console.error(`${C_RED}[ERROR_PW_EVAL_GET]${C_RESET} PW error eval GET ${secureAddress}: ${e.message}`); if (retryCount < MAX_RETRIES && e.message.includes('Target closed')) { console.warn(`${C_YELLOW}[RETRY_PW_GET]${C_RESET} Target closed? Retrying GET (${retryCount + 1}/${MAX_RETRIES}) after delay for ${secureAddress}`); await randomDelay(BASE_REQUEST_DELAY); return await checkRegistrations(secureAddress, retryCount + 1); } return null; }
}
async function registerWalletGroup(secureAddress, eligibleWallets, retryCount = 0) {
    let p; const url = `${API_BASE_URL}/save-registration`; try { p = { wallets: await Promise.all(eligibleWallets.map(async ({ address: ea, amount: am, privateKey: epk }) => { if (!epk) throw new Error(`No key ${ea}`); const s = new ethers.Wallet(epk); if (s.address.toLowerCase() !== ea.toLowerCase()) throw new Error(`Key mismatch ${ea}`); const sig = await generateSignature(s, ea, secureAddress, TOKENS_PER_NETWORK.chainId, TOKENS_PER_NETWORK.tokenType, am); return { eligibleAddress: String(ea).trim(), chainId: Number(TOKENS_PER_NETWORK.chainId), eligibleAddressType: 'ethereum', receivingAddress: String(secureAddress).trim(), signature: sig, tokenType: String(TOKENS_PER_NETWORK.tokenType).trim(), amount: String(am).trim() }; })) }; } catch (e) { console.error(`${C_RED}[ERROR_PAYLOAD]${C_RESET} Payload fail ${secureAddress}: ${e.message}`); return false; } console.log(`[DEBUG] Sending POST (via evaluate) ${secureAddress.substring(0, 10)}... (${p.wallets.length} wallets)`); try { const args = { apiUrl: url, apiPayload: p, targetOrigin: new URL(TARGET_PAGE_URL).origin, targetReferer: TARGET_PAGE_URL }; const res = await page.evaluate(async (a) => { const { apiUrl, apiPayload, targetOrigin, targetReferer } = a; try { const r = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/plain, */*', 'Origin': targetOrigin, 'Referer': targetReferer }, body: JSON.stringify(apiPayload) }); const s = r.status; const b = await r.text(); return { status: s, body: b }; } catch (e) { return { error: `Fetch POST error in evaluate: ${e.message || String(e)}` }; } }, args); if (res.error) { console.error(`${C_RED}[ERROR_EVAL_POST]${C_RESET} Eval error POST ${secureAddress}: ${res.error}`); if (retryCount < MAX_RETRIES && res.error.toLowerCase().includes('network')) { const wt = (BASE_REQUEST_DELAY * 2 * Math.pow(2, retryCount)); console.warn(`${C_YELLOW}[RETRY_EVAL_NET]${C_RESET} Retrying POST (${retryCount + 1}/${MAX_RETRIES}) after ${wt / 1000}s for ${secureAddress}`); await randomDelay(wt); return await registerWalletGroup(secureAddress, eligibleWallets, retryCount + 1); } return false; } const { status: s, body: b } = res; console.log(`[DEBUG] POST evaluate Response ${secureAddress.substring(0, 10)}... : Status ${s}`); if (s < 200 || s >= 300) { console.error(`${C_RED}[ERROR_API_POST]${C_RESET} Status ${s} ${secureAddress}. Resp: ${b.substring(0, 1000)}...`); if (s === 429) { console.warn(`${C_YELLOW}[RATE_LIMIT_POST]${C_RESET} 429 POST ${secureAddress}. Pause long...`); increaseGlobalDelay(); await randomDelay(CHECK_INTERVAL); return false; } if (s === 403) { console.error(`${C_RED}[BLOCK_POST]${C_RESET} 403 POST ${secureAddress}. BOT DETECTED? CHECK PROXY/FINGERPRINT/HEADERS.`); return false; } if (s >= 500 && retryCount < MAX_RETRIES) { const wt = (BASE_REQUEST_DELAY * 2 * Math.pow(2, retryCount)); console.warn(`${C_YELLOW}[RETRY_5xx]${C_RESET} Retrying POST (${retryCount + 1}/${MAX_RETRIES}) after ${wt / 1000}s for ${secureAddress}`); await randomDelay(wt); return await registerWalletGroup(secureAddress, eligibleWallets, retryCount + 1); } return false; } try { const d = JSON.parse(b); if (d && d.validationResult && d.validationResult.success === true) { console.log(`${C_GREEN}[SUCCESS_REGISTER]${C_RESET} Group registered ${secureAddress} (${eligibleWallets.length} wallets).`); return true; } else { const fr = d?.validationResult?.message || b.substring(0, 300); console.warn(`${C_YELLOW}[FAIL_REGISTER_API]${C_RESET} API reject (${s}) ${secureAddress}: ${fr}`); return false; } } catch (p) { console.error(`${C_RED}[ERROR_PARSE_POST]${C_RESET} Parse fail (Status ${s}) ${secureAddress}: ${p.message}. Body: ${b.substring(0, 300)}...`); return false; } } catch (e) { console.error(`${C_RED}[ERROR_PW_EVAL_POST]${C_RESET} PW error eval POST ${secureAddress}: ${e.message}`); if (retryCount < MAX_RETRIES) { const wt = (BASE_REQUEST_DELAY * 2 * Math.pow(2, retryCount)); console.warn(`${C_YELLOW}[RETRY_PW_EVAL]${C_RESET} Retrying POST (${retryCount + 1}/${MAX_RETRIES}) after ${wt / 1000}s for ${secureAddress}`); await randomDelay(wt); return await registerWalletGroup(secureAddress, eligibleWallets, retryCount + 1); } return false; }
}

// --- Función de Comparación (Corregida) ---
function compareRegistrations(currentRegistrations, expectedWallets, secureAddress) {
    if (currentRegistrations === null) {
        console.warn(`${C_YELLOW}[WARN]${C_RESET} Skip compare ${secureAddress.substring(0, 10)}... (fetch failed).`);
        return { isConsistent: false, anomalies: ['Fetch fail'], needsRegistration: [] };
    }

    const currentMap = new Map(currentRegistrations.map(r => [r.eligibleAddress.toLowerCase(), { receivingAddress: r.receivingAddress.toLowerCase(), chainId: r.chainId, tokenType: r.tokenType, revoked: r.revoked || false }]));
    const expectedMap = new Map(expectedWallets.map(w => [w.address.toLowerCase(), { receivingAddress: secureAddress.toLowerCase(), chainId: Number(TOKENS_PER_NETWORK.chainId), tokenType: TOKENS_PER_NETWORK.tokenType, revoked: false }]));
    let anomalies = [];
    let needsRegistration = []; // Definida aquí

    for (const [ea, ed] of expectedMap) {
        const cr = currentMap.get(ea);
        const cw = expectedWallets.find(w => w.address.toLowerCase() === ea);
        // ---> Usar needsRegistration <---
        if (!cr) { anomalies.push(`${ea.substring(0, 10)}..(Miss)`); if (cw) needsRegistration.push(cw); }
        else if (cr.revoked) { anomalies.push(`${ea.substring(0, 10)}..(Revoked)`); if (cw) needsRegistration.push(cw); }
        else if (cr.receivingAddress !== ed.receivingAddress) { anomalies.push(`${ea.substring(0, 10)}..(Dest:${cr.receivingAddress.substring(0, 10)})`); if (cw) needsRegistration.push(cw); }
        else if (cr.chainId !== ed.chainId) { anomalies.push(`${ea.substring(0, 10)}..(Chain:${cr.chainId})`); if (cw) needsRegistration.push(cw); }
        else if (cr.tokenType !== ed.tokenType) { anomalies.push(`${ea.substring(0, 10)}..(Token:${cr.tokenType})`); if (cw) needsRegistration.push(cw); }
    }
    for (const [ca] of currentMap) {
        // ---> Usar expectedMap <---
        if (!expectedMap.has(ca)) { anomalies.push(`${ca.substring(0, 10)}..(Extra)`); }
    }

    if (anomalies.length > 0) {
        console.warn(`${C_YELLOW}[ANOMALY]${C_RESET} ${anomalies.length} discreps ${secureAddress.substring(0, 10)}...`);
    }

    // ---> Return final verificado <---
    return {
        isConsistent: anomalies.length === 0,
        anomalies: anomalies,
        needsRegistration: needsRegistration
    };
}

// --- Ciclo Principal ---
async function monitorWallets() {
    await initializePlaywrightAndConfig();
    console.log("\n[INFO] Loading wallets & assignment...");
    const { walletGroups: wg, assignmentToShow: ats } = await loadWalletsAndAssignment(); // Obtiene los datos
    let tE = 0; Object.values(wg).forEach(g => tE += g.length); if (Object.keys(wg).length === 0 || tE === 0) { console.error(`${C_RED}[FATAL]${C_RESET} No valid groups.`); if (browser) await browser.close(); process.exit(1); }
    console.log('\n--- Loaded Assignment (Monitoring) ---');
    // await regenerateSecureAddressMap(); // No es necesario si se pobló el mapa global en loadWallets...
    ats.forEach(g => {
        const secureKey = secureAddressToKey.get(g.secureAddress.toLowerCase()); // Usa mapa global
        const cgw = secureKey ? wg[secureKey] : [];
        console.log(`\n[ASSIGNMENT] Secure: ${g.secureAddress} (${cgw?.length ?? 0} valid)`);
        if (cgw && cgw.length > 0) { cgw.slice(0, 3).forEach(w => console.log(`  - Eligible: ${w.address} | Amount: ${w.amount} HYPER`)); if (cgw.length > 3) console.log(`  ... and ${cgw.length - 3} more.`); }
        else { console.log("  (No valid eligibles assigned/loaded)"); }
    });
    console.log('------------------------------------\n'); console.log(`[INFO] Starting monitoring cycle ~ every ${(CHECK_INTERVAL / 1000)}s...`); await runMonitoringCycle(wg); setInterval(async () => await runMonitoringCycle(wg), CHECK_INTERVAL);
}
async function runMonitoringCycle(walletGroups) {
    console.log(`\n--- Starting check cycle [${new Date().toLocaleTimeString()}] ---`);
    const sks = Object.keys(walletGroups);
    let cycleHadRateLimit = false;
    for (const sk of sks) {
        const ew = walletGroups[sk]; if (!ew || ew.length === 0) continue;
        let sa; try { sa = new ethers.Wallet(sk).address; } catch (e) { console.warn(`${C_YELLOW}[WARN] Invalid key cycle: ${sk.substring(0, 10)}... Skip.${C_RESET}`); continue; }
        console.log(`${C_BLUE}[CHECKING]${C_RESET} Verifying ${sa} (${ew.length} wallets)`);
        const cr = await checkRegistrations(sa, 0);
        if (cr !== null) {
            // ---> LLamada que daba error, ahora debería recibir el objeto correcto <---
            const { isConsistent: iC, anomalies: an, needsRegistration: nR } = compareRegistrations(cr, ew, sa);
            // -----------------------------------------------------------------------
            if (!iC) {
                console.warn(`${C_YELLOW}[ANOMALY_DETAIL]${C_RESET} Discreps for ${sa}: ${an.join(', ')}`);
                anomalyCounter.set(sa, (anomalyCounter.get(sa) || 0) + 1);
                if (nR && nR.length > 0) {
                    console.log(`[ACTION_NEEDED] Fixing ${nR.length} for ${sa}...`);
                    const success = await registerMissingOrIncorrectWallets(sk, nR);
                    if (success) { console.log(`${C_GREEN}[ACTION_RESULT]${C_RESET} Register attempt OK for ${sa}.`); }
                    else { console.error(`${C_RED}[ACTION_RESULT]${C_RESET} Register attempt FAIL for ${sa}.`); cycleHadRateLimit = true; }
                    // La pausa POST_ACTION_DELAY está dentro de registerMissingOrIncorrectWallets
                } else if (an.length > 0) { console.log(`[INFO] Anomalies ${sa}, no reg action.`); }
            } else {
                console.log(`${C_GREEN}[OK]${C_RESET} Status OK ${sa} (${ew.length} wallets)`);
            }
        } else {
            console.warn(`${C_YELLOW}[INFO]${C_RESET} Skipped compare/action ${sa} (GET fail).`);
            cycleHadRateLimit = true;
        }
        await randomDelay(); // Pausa entre wallets
    } // Fin for
    if (!cycleHadRateLimit) { decreaseGlobalDelay(); } // Bajar delay si el ciclo fue limpio
    if (anomalyCounter.size > 0) { await saveAnomalyReport(); }
    console.log(`--- Check cycle finished [${new Date().toLocaleTimeString()}] (Current Delay Factor: ${currentGlobalDelayFactor.toFixed(2)}) ---`);
}

// --- Punto de Entrada y Cierre ---
async function main() {
    // await regenerateSecureAddressMap(); // No es necesario si se hace en load
    await monitorWallets();
}
main().catch(async (error) => { console.error(`\n${C_RED}***** FATAL ERROR *****${C_RESET}`); console.error(error.stack || error.message); console.error(`${C_RED}***********************${C_RESET}`); if (browser && browser.isConnected()) { console.log("[INFO] Closing connection on fatal error..."); await browser.close(); } process.exit(1); });
process.on('SIGINT', async () => { console.log("\n[INFO] Closing connection on interrupt (Ctrl+C)..."); if (browser && browser.isConnected()) { await browser.close(); } process.exit(0); });
process.on('exit', (code) => { console.log(`[INFO] Exiting with code ${code}.`); if (browser && browser.isConnected()) { console.log("[INFO] Closing connection on exit..."); browser.close().catch(err => console.error(`${C_RED}Error closing on exit:${C_RESET}`, err.message)); } });
