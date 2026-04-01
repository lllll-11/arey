const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const openRouterService = require('./openRouterService');

const execAsync = util.promisify(exec);
const BACKEND_ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(BACKEND_ROOT, '.backups');

const EDITABLE_EXTENSIONS = ['.js', '.json'];
const EXCLUDED_DIRS = ['node_modules', '.backups', '.git', 'icons'];
const EXCLUDED_FILES = ['.env', '.env.example', 'package-lock.json'];
const MAX_FILE_SIZE = 120_000; // ~120 KB

function getEditableFiles(dir = BACKEND_ROOT, prefix = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    if (EXCLUDED_DIRS.includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files = files.concat(getEditableFiles(fullPath, relPath));
    } else if (
      EDITABLE_EXTENSIONS.includes(path.extname(entry.name)) &&
      !EXCLUDED_FILES.includes(entry.name)
    ) {
      const stat = fs.statSync(fullPath);
      if (stat.size <= MAX_FILE_SIZE) files.push(relPath);
    }
  }
  return files;
}

function backupFile(relPath) {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const fullPath = path.join(BACKEND_ROOT, relPath);
  if (!fs.existsSync(fullPath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = relPath.replace(/[/\\]/g, '__');
  const backupPath = path.join(BACKUP_DIR, `${safeName}.${ts}.bak`);
  fs.copyFileSync(fullPath, backupPath);
  return backupPath;
}

function restoreBackup(relPath, backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) return false;
  const fullPath = path.join(BACKEND_ROOT, relPath);
  fs.copyFileSync(backupPath, fullPath);
  return true;
}

async function validateSyntax(relPath) {
  if (!relPath.endsWith('.js')) return true;
  const fullPath = path.join(BACKEND_ROOT, relPath);
  try {
    await execAsync(`node -c "${fullPath}"`, { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function extractJson(text) {
  const clean = text
    .replace(/^```(?:json)?\s*/gm, '')
    .replace(/```\s*$/gm, '')
    .trim();
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function executeCodeChange(request) {
  const editableFiles = getEditableFiles();
  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini';

  // ── Step 1: Plan which files to read ──
  const planPrompt = `Eres Arey, una IA que puede modificar su propio codigo fuente Node.js.
Tu backend tiene estos archivos editables:
${editableFiles.map(f => `- ${f}`).join('\n')}

El owner te pide: "${request}"

Responde UNICAMENTE con JSON valido (sin markdown, sin backticks):
{
  "filesToRead": ["archivo1.js"],
  "plan": "breve descripcion de que vas a hacer"
}
Escoge solo los archivos estrictamente necesarios.`;

  const planRaw = await openRouterService.chat(planPrompt, request, {
    model,
    temperature: 0.15,
    maxTokens: 1000,
  });

  const plan = extractJson(planRaw);
  if (!plan || !Array.isArray(plan.filesToRead) || plan.filesToRead.length === 0) {
    throw new Error(`No pude planificar. Respuesta del modelo: ${planRaw.slice(0, 250)}`);
  }

  const validFiles = plan.filesToRead.filter(f => editableFiles.includes(f));
  if (validFiles.length === 0) {
    throw new Error(`Archivos sugeridos no existen o no son editables: ${plan.filesToRead.join(', ')}`);
  }

  // ── Step 2: Read those files ──
  const fileContents = {};
  for (const rel of validFiles) {
    fileContents[rel] = fs.readFileSync(path.join(BACKEND_ROOT, rel), 'utf-8');
  }

  // ── Step 3: Ask LLM to generate modifications ──
  const codePrompt = `Eres Arey. Modificas tu propio codigo fuente.

CAMBIO SOLICITADO: "${request}"
PLAN: ${plan.plan}

ARCHIVOS ACTUALES:
${Object.entries(fileContents)
  .map(([name, content]) => `\n=== ${name} ===\n${content}\n=== FIN ${name} ===`)
  .join('\n')}

REGLAS:
- Responde UNICAMENTE con JSON valido. Sin markdown. Sin backticks. Sin texto extra.
- Incluye SOLO archivos que cambian.
- Cada archivo lleva su contenido COMPLETO (no fragmentos ni "// ...").
- Conserva TODO el codigo existente que no necesita cambios.
- No rompas funcionalidad existente.

Formato obligatorio:
{
  "changes": [
    { "file": "ruta/archivo.js", "content": "contenido COMPLETO del archivo modificado" }
  ],
  "summary": "resumen corto de los cambios"
}`;

  const codeRaw = await openRouterService.chat(codePrompt, `Aplica: ${request}`, {
    model,
    temperature: 0.1,
    maxTokens: 32000,
  });

  const result = extractJson(codeRaw);
  if (!result || !Array.isArray(result.changes) || result.changes.length === 0) {
    throw new Error(`No se generaron cambios. Respuesta: ${codeRaw.slice(0, 300)}`);
  }

  // Validate files are editable
  for (const ch of result.changes) {
    if (!editableFiles.includes(ch.file)) {
      throw new Error(`Archivo no permitido: ${ch.file}`);
    }
    if (typeof ch.content !== 'string' || ch.content.length < 10) {
      throw new Error(`Contenido invalido para ${ch.file}`);
    }
  }

  // ── Step 4: Backup, write, validate ──
  const backupsMap = {};
  for (const ch of result.changes) {
    backupsMap[ch.file] = backupFile(ch.file);
    fs.writeFileSync(path.join(BACKEND_ROOT, ch.file), ch.content, 'utf-8');
  }

  // Syntax check .js files; rollback if broken
  for (const ch of result.changes) {
    const ok = await validateSyntax(ch.file);
    if (!ok) {
      // Rollback all changes
      for (const ch2 of result.changes) {
        if (backupsMap[ch2.file]) restoreBackup(ch2.file, backupsMap[ch2.file]);
      }
      throw new Error(`Error de sintaxis en ${ch.file}. Revertí todos los cambios.`);
    }
  }

  return {
    summary: result.summary || plan.plan,
    modifiedFiles: result.changes.map(c => c.file),
    backups: Object.values(backupsMap).filter(Boolean),
  };
}

module.exports = { executeCodeChange, getEditableFiles };
