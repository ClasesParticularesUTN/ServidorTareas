const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");

const app = express();

/* ======================= CORS (CLAVE) ======================= */
app.use(cors({
  origin: [
    "https://clasesparticularesutn.com.ar",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));

// 🔴 NECESARIO para preflight
app.options("*", cors());

app.use(express.json());

/* ======================= CONFIG ======================= */
const MAX_OUTPUT_LENGTH = 100 * 1024; // 100 KB
const TIMEOUT_MS = 5000;

// Carpeta temporal
const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR);
}

/* ======================= ENDPOINT ======================= */
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

  const compileCmd = `
    ulimit -t 5 -v 262144 &&
    g++ ${cppPath} -std=c++17 -O2 -o ${binPath}
  `;

  exec(compileCmd, (compileErr, stdout, stderr) => {
    if (compileErr) {
      const humanizado = humanizarErrores(stderr, codeLines);
      limpiarArchivos(cppPath, binPath);
      return res.json({ output: humanizado });
    }

    const proceso = spawn(binPath, [], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let output = "";
    let error = "";
    let outputTruncado = false;
    let finalizadoPorTimeout = false;

    if (input) proceso.stdin.write(input + "\n");
    proceso.stdin.end();

    proceso.stdout.on("data", data => {
      if (output.length < MAX_OUTPUT_LENGTH) {
        output += data.toString();
        if (output.length >= MAX_OUTPUT_LENGTH) {
          outputTruncado = true;
        }
      }
    });

    proceso.stderr.on("data", data => {
      error += data.toString();
    });

    const timeout = setTimeout(() => {
      finalizadoPorTimeout = true;
      proceso.kill("SIGTERM");
    }, TIMEOUT_MS);

    proceso.on("close", (code, signal) => {
      clearTimeout(timeout);
      limpiarArchivos(cppPath, binPath);

      let resultado = "";

      if (output) resultado += output;
      if (error) resultado += "\n⚠️ STDERR:\n" + error;

      if (outputTruncado) {
        resultado += "\n\n⚠️ Salida truncada (más de 100 KB)";
      }

      if (finalizadoPorTimeout) {
        resultado += "\n\n⏱️ Proceso detenido por exceder el tiempo límite (5s)";
      } else if (signal) {
        resultado += `\n\n💥 Proceso terminado por señal: ${signal}`;
      } else if (code !== 0) {
        resultado += `\n\n💥 Error en tiempo de ejecución (código ${code})`;
      }

      if (!resultado.trim()) {
        resultado = "⚠️ El programa no produjo salida.";
      }

      res.json({ output: resultado });
    });

    proceso.on("error", err => {
      clearTimeout(timeout);
      limpiarArchivos(cppPath, binPath);
      res.json({ output: `❌ Error al ejecutar el programa: ${err.message}` });
    });
  });
});

/* ======================= ERRORES PEDAGÓGICOS ======================= */
function humanizarErrores(stderr, codeLines) {
  const lineas = stderr.split("\n");

  for (const linea of lineas) {
    if (!linea.includes("error:")) continue;

    const m = linea.match(/:(\d+):\d+:/);
    const numLinea = m ? parseInt(m[1]) : null;
    const codigo = numLinea ? codeLines[numLinea - 1] : "";

    if (/expected.*;/.test(linea)) {
      return formatearError(numLinea, codigo, "Falta un punto y coma (;).", "En C++, casi todas las instrucciones terminan con ;");
    }

    if (/expected.*\}/.test(linea)) {
      return formatearError(numLinea, codigo, "Falta cerrar una llave }.", "Cada { debe tener su }.");
    }

    if (/expected.*\)/.test(linea)) {
      return formatearError(numLinea, codigo, "Falta cerrar un paréntesis ).", "Revisá condiciones y funciones.");
    }

    if (/missing terminating " character/.test(linea)) {
      return formatearError(numLinea, codigo, "String sin cerrar.", "Cada \" debe cerrarse.");
    }

    if (/expected primary-expression/.test(linea)) {
      return formatearError(numLinea, codigo, "Expresión incompleta.", "Falta una variable, número o función.");
    }

    if (/expected declaration before/.test(linea)) {
      return formatearError(numLinea, codigo, "Llave } de más.", "Cerraste una llave que no abriste.");
    }

    if (/was not declared in this scope/.test(linea)) {
      const m2 = linea.match(/‘(.+?)’ was not declared/);
      return formatearError(numLinea, codigo, `Identificador '${m2 ? m2[1] : ""}' no declarado.`, "Declaralo antes de usarlo.");
    }

    return formatearError(numLinea, codigo, "Error de sintaxis.", "Revisá esta línea y la anterior.");
  }

  return "❗ Error de compilación.";
}

function formatearError(linea, codigo, error, ayuda) {
  return `
🚫 Error de compilación

📍 Línea ${linea}
❌ ${error}

🧾 Código:
${codigo}

💡 Sugerencia:
${ayuda}
`.trim();
}

/* ======================= UTIL ======================= */
function limpiarArchivos(...archs) {
  archs.forEach(f => fs.unlink(f, () => {}));
}

/* ======================= HEALTH ======================= */
app.get("/health", (req, res) => {
  res.type("text/plain").send("OK");
});

/* ======================= SERVER ======================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto", PORT);
});

module.exports = app;
