const express = require("express");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");

const app = express();

/* ======================= CORS MANUAL ======================= */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://clasesparticularesutn.com.ar");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

/* ======================= CONFIG ======================= */
const MAX_OUTPUT_LENGTH = 100 * 1024;
const TIMEOUT_MS = 5000;

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

/* ======================= COMPILE ======================= */
app.post("/compile", (req, res) => {
  const { code, input } = req.body;

  if (!code || typeof code !== "string") {
    return res.json({ output: "❌ Código inválido." });
  }

  const codeLines = code.split("\n");

  const id = randomUUID();
  const cppPath = path.join(TMP_DIR, `temp_${id}.cpp`);
  const binPath = path.join(TMP_DIR, `temp_${id}`);

  fs.writeFileSync(cppPath, code);

  exec(
    `ulimit -t 5 -v 262144 && g++ ${cppPath} -std=c++17 -O2 -o ${binPath}`,
    (compileErr, stdout, stderr) => {
      if (compileErr) {
        const humanizado = humanizarErrores(stderr, codeLines);

        limpiarArchivos(cppPath, binPath);

        if (humanizado) {
          return res.json({
            output:
              humanizado +
              "\n\n🔧 Mensaje original del compilador (g++):\n" +
              stderr
          });
        } else {
          return res.json({
            output:
              "❌ Error de compilación.\n\n🔧 Mensaje original del compilador (g++):\n" +
              stderr
          });
        }
      }

      const proceso = spawn(binPath, [], {
        stdio: ["pipe", "pipe", "pipe"]
      });

      let output = "";
      let error = "";

      if (input) proceso.stdin.write(input + "\n");
      proceso.stdin.end();

      proceso.stdout.on("data", d => (output += d));
      proceso.stderr.on("data", d => (error += d));

      const timeout = setTimeout(() => proceso.kill("SIGTERM"), TIMEOUT_MS);

      proceso.on("close", code => {
        clearTimeout(timeout);
        limpiarArchivos(cppPath, binPath);

        let resultado = output || "";

        if (error) resultado += "\n⚠️ STDERR:\n" + error;
        if (!resultado.trim()) resultado = "⚠️ El programa no produjo salida.";

        res.json({ output: resultado });
      });
    }
  );
});

/* ======================= ERRORES HUMANOS ======================= */
function humanizarErrores(stderr, codeLines) {
  const lineas = stderr.split("\n");

  for (const linea of lineas) {
    if (!linea.includes("error:")) continue;

    const m = linea.match(/:(\d+):\d+:/);
    const numLinea = m ? parseInt(m[1]) : null;
    const codigo = numLinea ? codeLines[numLinea - 1] : "";

    if (/expected.*;/.test(linea))
      return formatear(numLinea, codigo, "Falta un punto y coma (;).");

    if (/expected.*\}/.test(linea))
      return formatear(numLinea, codigo, "Falta cerrar una llave }.");

    if (/expected.*\)/.test(linea))
      return formatear(numLinea, codigo, "Falta cerrar un paréntesis ).");

    if (/missing terminating " character/.test(linea))
      return formatear(numLinea, codigo, "String sin cerrar.");

    if (/was not declared in this scope/.test(linea)) {
      const v = linea.match(/‘(.+?)’/);
      return formatear(numLinea, codigo, `Identificador '${v ? v[1] : ""}' no declarado.`);
    }

    return null; // 👈 NO inventamos errores
  }

  return null;
}

function formatear(linea, codigo, error) {
  return `
🚫 Error de compilación
📍 Línea ${linea}
❌ ${error}

🧾 Código:
${codigo}
`.trim();
}

/* ======================= UTIL ======================= */
function limpiarArchivos(...files) {
  files.forEach(f => fs.unlink(f, () => {}));
}

/* ======================= HEALTH ======================= */
app.get("/health", (_, res) => res.send("OK"));

/* ======================= SERVER ======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto", PORT);
});

module.exports = app;
