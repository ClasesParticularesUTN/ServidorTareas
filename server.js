const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const { randomUUID } = require("crypto");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ================= CONFIG =================
const MAX_OUTPUT_LENGTH = 100 * 1024; // 100 KB
const TIMEOUT_MS = 5000;

// Carpeta temporal
const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR);
}

// ================= ENDPOINT =================
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

// ================= ERRORES PEDAGÓGICOS =================
function humanizarErrores(stderr, codeLines) {
  const lineas = stderr.split("\n");

  for (const linea of lineas) {
    if (!linea.includes("error:")) continue;

    const matchLinea = linea.match(/:(\d+):\d+:/);
    const numLinea = matchLinea ? parseInt(matchLinea[1]) : null;
    const codigo = numLinea ? codeLines[numLinea - 1] : "";

    if (/expected.*;/.test(linea)) {
      return formatearError({
        linea: numLinea,
        codigo,
        error: "Falta un punto y coma (;).",
        ayuda: "En C++, casi todas las instrucciones terminan con ;"
      });
    }

    if (/expected.*\}/.test(linea)) {
      return formatearError({
        linea: numLinea,
        codigo,
        error: "Falta cerrar una llave }.",
        ayuda: "Cada { debe tener su } correspondiente."
      });
    }

    if (/expected.*\)/.test(linea)) {
      return formatearError({
        linea: numLinea,
        codigo,
        error: "Falta cerrar un paréntesis ).",
        ayuda: "Revisá condiciones y llamadas a funciones."
      });
    }

    if (/missing terminating " character/.test(linea)) {
      return formatearError({
        linea: numLinea,
        codigo,
        error: "String sin cerrar.",
        ayuda: "Cada \" debe tener su comilla de cierre."
      });
    }

    if (/expected primary-expression/.test(linea)) {
      return formatearError({
        linea: numLinea,
        codigo,
        error: "Expresión incompleta.",
        ayuda: "Falta una variable, número o llamada a función."
      });
    }

    if (/expected declaration before/.test(linea)) {
      return formatearError({
        linea: numLinea,
        codigo,
        error: "Llave } de más.",
        ayuda: "Probablemente cerraste una llave que no abriste."
      });
    }

    if (/was not declared in this scope/.test(linea)) {
      const m = linea.match(/‘(.+?)’ was not declared/);
      if (m && ["cout", "cin", "endl"].includes(m[1])) {
        return formatearError({
          linea: numLinea,
          codigo,
          error: `Uso incorrecto de ${m[1]}.`,
          ayuda: "¿Te falta #include <iostream> o using namespace std?"
        });
      }

      return formatearError({
        linea: numLinea,
        codigo,
        error: `Identificador '${m ? m[1] : ""}' no declarado.`,
        ayuda: "Declaralo antes de usarlo."
      });
    }

    if (/lvalue required as left operand/.test(linea)) {
      return formatearError({
        linea: numLinea,
        codigo,
        error: "Uso incorrecto del operador =.",
        ayuda: "Para comparar se usa ==, no =."
      });
    }

    return formatearError({
      linea: numLinea,
      codigo,
      error: "Error de sintaxis.",
      ayuda: "Revisá esta línea y la anterior."
    });
  }

  return "❗ Error de compilación. Revisá la sintaxis.";
}

function formatearError({ linea, codigo, error, ayuda }) {
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

// ================= UTILIDADES =================
function limpiarArchivos(...archs) {
  for (const file of archs) {
    fs.unlink(file, () => {});
  }
}

// ================= HEALTH =================
app.get("/health", (req, res) => {
  res.type("text/plain").send("OK");
});

// ================= SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor escuchando en puerto", PORT);
});

module.exports = app;
