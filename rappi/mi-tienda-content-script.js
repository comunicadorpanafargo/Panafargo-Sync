// ============================================================
// rappi/mi-tienda-content-script.js
// ============================================================
// V4 — Automatización directa en Mi Tienda (mitienda.rappi.com.co).
//
// Se ejecuta DENTRO de la pestaña de Mi Tienda, usando la sesión ya
// iniciada por el empleado en su propio navegador. Nunca recibe,
// maneja ni almacena usuario/contraseña de Rappi — solo interactúa
// con el DOM de la página, igual que lo haría el empleado a mano.
//
// Recorrido completo automatizado (HTML real confirmado por el
// usuario, capturado navegando el flujo real una vez):
//   1. "Crea tus productos" (selección) → clic en "Personalizados"
//      selector: [data-cy="products_personalized_button"]
//   2. "Crea productos personalizados" (introducción) → clic en el
//      "Subir plantilla" de navegación (ese SÍ es solo un enlace,
//      no contiene el input real)
//      selector: [data-cy="products_catalog_upload_template_button"]
//   3. "Sube la plantilla" → coloca el .xlsx en el input real y
//      espera a que se habilite "Continuar"
//      input:    [data-cy="products_catalog_upload_file_button"] input
//      continuar:[data-cy="products_catalog_continue_button"]
//   4. "Carga las imágenes y revisa la información" → clic en
//      "¿Prefieres cargar múltiples imágenes a la vez? Cárgalas aquí"
//      (sin data-cy propio, se busca por texto exacto del enlace)
//   5. Drawer de carga masiva de imágenes → coloca el .zip y espera
//      a que se habilite el "Continuar" del drawer (también sin
//      data-cy propio — se busca por texto, acotado al drawer)
//      input: input[type="file"][accept=".zip"]
//   6. Continúa desde el drawer y crea los productos.
//      La asociación es un proceso independiente y no se inicia aquí.
// ============================================================

const SELECTOR_BOTON_PERSONALIZADOS = '[data-cy="products_personalized_button"]';
const SELECTOR_BOTON_IR_A_SUBIR_PLANTILLA = '[data-cy="products_catalog_upload_template_button"]';
const SELECTOR_INPUT_PLANTILLA = '[data-cy="products_catalog_upload_file_button"] input[type="file"]';
const SELECTOR_BOTON_CONTINUAR_PLANTILLA = '[data-cy="products_catalog_continue_button"]';
const SELECTOR_INPUT_ZIP =
  'input.file[type="file"][accept=".zip"], input[type="file"][accept*=".zip"], input[type="file"][accept*="zip"]';
const SELECTOR_DRAWER = "lib-drawer";
const TEXTO_LINK_MULTIPLES_IMAGENES = "Cárgalas aquí";
const TEXTO_TITULO_REVISION_IMAGENES = "Carga las imágenes y revisa la información";
const TEXTO_BOTON_CONTINUAR = "Continuar";
const TEXTO_BOTON_CREAR_PRODUCTOS = "Crear productos";
const CLAVE_REINTENTO_404 = "panafargoSync:zipReloadIntento";
const ESPERAS_REINTENTO_404_MS = [60000]; // 1 minuto, un solo intento de recarga
const DURACION_BARRA_REINTENTO_404_MS = 58000;
let timerReintento404 = null;
let intervaloProgresoReintento404 = null;
let barraProgresoReintento404 = null;

const SELECTOR_INPUT_PLANTILLA_ASOCIACION =
  'input.file[type="file"][accept=".csv,.xlsx"], input[type="file"][accept*=".xlsx"]';
const TEXTO_BOTON_ASOCIAR_PRODUCTOS = "Asociar productos";

function esperarBotonHabilitadoConTexto(texto, timeoutMs) {
  return new Promise((resolve) => {
    const intervalo = setInterval(() => {
      const el = buscarBotonPorTexto(texto);
      if (el && !el.disabled) {
        clearInterval(intervalo);
        clearTimeout(timer);
        resolve(el);
      }
    }, 300);
    const timer = setTimeout(() => {
      clearInterval(intervalo);
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Si esta carga de página viene de una auto-recarga programada tras
 * el "glitch" de página no encontrada (ver esperarResultadoProcesamientoZip),
 * revisa si la pantalla sigue rota. Si ya se ve bien, limpia la marca.
 * Si sigue rota, agota el único reintento y deja la pantalla para
 * revisión manual. Esto sobrevive a la recarga porque usa sessionStorage de la
 * pestaña (el estado en memoria del content script se pierde con cada
 * recarga real de la página).
 */
(async function revisarReintento404AlCargar() {
  const intentoGuardado = sessionStorage.getItem(CLAVE_REINTENTO_404);
  if (intentoGuardado === null) return;

  const intento = parseInt(intentoGuardado, 10);
  const siguePagina404 = normalizarTexto(document.body?.innerText).includes("pagina no encontrada");

  if (siguePagina404) {
    if (intento >= ESPERAS_REINTENTO_404_MS.length) {
      sessionStorage.removeItem(CLAVE_REINTENTO_404);
      return; // se agotaron los reintentos; queda como está para revisión manual
    }
    sessionStorage.setItem(CLAVE_REINTENTO_404, String(intento + 1));
    timerReintento404 = setTimeout(() => location.reload(), ESPERAS_REINTENTO_404_MS[intento]);
    return;
  }

  // La recarga resolvió la vista de error; continúa la creación, pero
  // nunca pulsa "Asociar productos".
  sessionStorage.removeItem(CLAVE_REINTENTO_404);
  continuarYCcrearProductos()
    .catch((err) => console.error("No se pudo continuar la creación de productos tras la recarga:", err));
})();

chrome.runtime.onMessage.addListener((mensaje, _sender, sendResponse) => {
  if (mensaje?.tipo === "RAPPI_LIMPIAR_SESION") {
    const cargaEnCurso = sessionStorage.getItem(CLAVE_REINTENTO_404) !== null;
    if (!cargaEnCurso) {
      sessionStorage.removeItem(CLAVE_REINTENTO_404);
      clearTimeout(timerReintento404);
      clearInterval(intervaloProgresoReintento404);
      barraProgresoReintento404?.remove();
    }
    sendResponse({ ok: true, cargaEnCurso });
    return;
  }

  if (mensaje?.tipo === "RAPPI_SUBIR_LOTE") {
    ejecutarSubida(mensaje)
      .then((resultado) => sendResponse({ ok: true, ...resultado }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // indica respuesta asíncrona
  }

  if (mensaje?.tipo === "RAPPI_SUBIR_PLANTILLA_ASOCIACION_AHORA") {
    subirPlantillaAsociacionYaGenerada(mensaje.archivoBase64, mensaje.archivoNombre)
      .then((resultado) => sendResponse({ ok: true, ...resultado }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

/**
 * Sube un archivo de asociación YA ARMADO (el usuario lo subió tal
 * cual desde el popup) directo al input de "Subir plantilla" de
 * asociación de la pantalla actual — no rellena nada, no hace
 * matching por SKU, asume que el archivo ya viene listo. Pensado para
 * cuando la pestaña ya está parada en esa pantalla (manual o
 * reintento), sin pasar por todo el flujo de creación de productos.
 */
async function subirPlantillaAsociacionYaGenerada(archivoBase64, archivoNombre) {
  const input = await esperarSelector(SELECTOR_INPUT_PLANTILLA_ASOCIACION, 15000);
  if (!input) {
    throw new Error(
      'No encontré el input de "Subir plantilla" de asociación en esta pestaña. Verifica que estés parado en esa pantalla.'
    );
  }

  const archivo = base64AArchivo(
    archivoBase64,
    archivoNombre || `asociacion_${Date.now()}.xlsx`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  asignarArchivosAInput(input, [archivo]);

  const botonAsociarFinal = await esperarBotonHabilitadoConTexto(TEXTO_BOTON_ASOCIAR_PRODUCTOS, 120000);
  if (!botonAsociarFinal) {
    return {
      mensaje:
        'La plantilla se cargó, pero "Asociar productos" no se habilitó en 2 minutos. Revisa el archivo en Mi Tienda.',
    };
  }
  return { mensaje: 'Plantilla lista. Revisa los datos y pulsa "Asociar productos" en Mi Tienda para finalizar.' };
}

async function ejecutarSubida({ xlsxBase64, xlsxNombre, imagenesZipBase64, imagenesZipNombre }) {
  let etapa = "inicio";
  try {
    etapa = "plantilla";
    return await ejecutarSubidaPorEtapas(
      { xlsxBase64, xlsxNombre, imagenesZipBase64, imagenesZipNombre },
      (nombreEtapa) => { etapa = nombreEtapa; }
    );
  } catch (err) {
    throw new Error(`Fallo en la etapa ${etapa}: ${err.message}`);
  }
}

async function ejecutarSubidaPorEtapas(
  { xlsxBase64, xlsxNombre, imagenesZipBase64, imagenesZipNombre },
  establecerEtapa
) {
  if (normalizarTexto(document.body?.innerText).includes("pagina no encontrada")) {
    throw new Error(
      'La pestaña de Mi Tienda ya estaba mostrando "página no encontrada" (residuo de un intento anterior) antes de empezar. Recarga esa pestaña (F5) y vuelve a intentar.'
    );
  }

  const estadoInicial = await esperarEstadoDelFlujo(20000);
  if (estadoInicial?.tipo === "imagenes") {
    establecerEtapa("continuar_desde_revision");
    return subirImagenes(
      imagenesZipBase64,
      imagenesZipNombre,
      establecerEtapa,
      estadoInicial.enlace,
      estadoInicial.inputZip
    );
  }

  if (estadoInicial?.tipo !== "plantilla") {
    throw new Error(
      "Mi Tienda no terminó de cargar la pantalla de plantilla ni la pantalla de imágenes. Recarga la pestaña e intenta nuevamente."
    );
  }

  // ---- Paso 1: "Crea tus productos" → elegir "Personalizados" ----
  const botonPersonalizados = document.querySelector(SELECTOR_BOTON_PERSONALIZADOS);
  if (botonPersonalizados) {
    botonPersonalizados.click();
    await esperarSelector(`${SELECTOR_BOTON_IR_A_SUBIR_PLANTILLA}, ${SELECTOR_INPUT_PLANTILLA}`, 10000);
  }

  // ---- Paso 2: pantalla de introducción → navegar a la real ----
  let inputPlantilla = document.querySelector(SELECTOR_INPUT_PLANTILLA);
  if (!inputPlantilla) {
    const botonIrASubir = document.querySelector(SELECTOR_BOTON_IR_A_SUBIR_PLANTILLA);
    if (botonIrASubir) {
      botonIrASubir.click();
      inputPlantilla = await esperarSelector(SELECTOR_INPUT_PLANTILLA, 10000);
    }
  }
  if (!inputPlantilla) {
    throw new Error(
      'No se encontró el formulario de carga de la plantilla. Verifica que estés dentro de Mi Tienda → Productos → creación por lotes.'
    );
  }

  // ---- Paso 3: subir la plantilla .xlsx y esperar "Continuar" ----
  const archivoXlsx = base64AArchivo(
    xlsxBase64,
    xlsxNombre,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  asignarArchivosAInput(inputPlantilla, [archivoXlsx]);

  const resultadoEsperaPlantilla = await esperarContinuarPlantillaOAvance(60000);
  if (!resultadoEsperaPlantilla) {
    return {
      paso: "plantilla_subida_sin_continuar",
      mensaje:
        'Se subió la plantilla, pero el botón "Continuar" no se habilitó en 60s ni la pantalla avanzó a la carga de imágenes. Revisa manualmente si el archivo es válido.',
    };
  }
  if (resultadoEsperaPlantilla.tipo === "boton") {
    resultadoEsperaPlantilla.el.click();
  }
  // Si resultadoEsperaPlantilla.tipo === "avanzo", Rappi ya pasó solo a
  // la pantalla de imágenes (sin necesidad de un clic en "Continuar")
  // y no hace falta hacer nada más aquí.

  return subirImagenes(imagenesZipBase64, imagenesZipNombre, establecerEtapa);
}

function detectarEstadoDelFlujo() {
  const enlace = buscarElementoPorTexto("a, button, [role='button']", TEXTO_LINK_MULTIPLES_IMAGENES);
  const inputZip = document.querySelector(SELECTOR_INPUT_ZIP);
  const tituloRevision = buscarElementoPorTexto("h1, h2, h3, p", TEXTO_TITULO_REVISION_IMAGENES);
  if (enlace || inputZip || tituloRevision) return { tipo: "imagenes", enlace, inputZip };

  if (document.querySelector(SELECTOR_INPUT_PLANTILLA) || document.querySelector(SELECTOR_BOTON_PERSONALIZADOS)) {
    return { tipo: "plantilla" };
  }
  return null;
}

function esperarEstadoDelFlujo(timeoutMs) {
  return new Promise((resolve) => {
    const revisar = () => detectarEstadoDelFlujo();
    const estadoInicial = revisar();
    if (estadoInicial) return resolve(estadoInicial);

    const intervalo = setInterval(() => {
      const estado = revisar();
      if (estado) {
        clearInterval(intervalo);
        clearTimeout(timer);
        resolve(estado);
      }
    }, 200);
    const timer = setTimeout(() => {
      clearInterval(intervalo);
      resolve(null);
    }, timeoutMs);
  });
}

async function subirImagenes(
  imagenesZipBase64,
  imagenesZipNombre,
  establecerEtapa,
  enlaceInicial = null,
  inputInicial = null
) {
  // ---- Paso 4: pantalla de revisión → abrir carga múltiple de imágenes ----
  establecerEtapa("abrir_carga_de_imagenes");
  const linkMultiples = enlaceInicial || await esperarElementoPorTexto(
    "a, button, [role='button']",
    TEXTO_LINK_MULTIPLES_IMAGENES,
    15000
  );
  let inputZip = inputInicial;
  if (!inputZip && linkMultiples) {
    linkMultiples.click();
    inputZip = await esperarSelector(SELECTOR_INPUT_ZIP, 15000);
  }
  if (!inputZip) {
    return {
      paso: "imagenes_formulario_no_encontrado",
      mensaje:
        'La plantilla sí fue procesada, pero no apareció el formulario de imágenes masivas (.zip). Revisa la pantalla de imágenes en Mi Tienda.',
    };
  }

  // ---- Paso 5: subir el .zip y esperar "Continuar" del drawer ----
  establecerEtapa("asignar_zip");
  const archivoZip = base64AArchivo(imagenesZipBase64, imagenesZipNombre, "application/zip");
  asignarArchivosAInput(inputZip, [archivoZip]);
  const archivoAsignado = await esperarArchivosAsignados(inputZip, 5000);
  if (!archivoAsignado) {
    return {
      paso: "zip_no_asignado",
      mensaje: "Mi Tienda no detectó el archivo ZIP de imágenes. Intenta nuevamente desde el enlace Cárgalas aquí.",
    };
  }

  // ---- Paso 5b: esperar a que Rappi termine de procesar el .zip ----
  // Se espera la señal real de éxito o error antes de continuar con la creación.
  establecerEtapa("procesar_zip");
  const progresoCarga = mostrarProgresoCargaImagenes();
  let r;
  try {
    r = await esperarResultadoProcesamientoZip(600000);
  } catch (err) {
    progresoCarga.quitar();
    throw err;
  }
  const traza = describirTraza(r);

  if (r.estado === "exito") {
    establecerEtapa("crear_productos");
    progresoCarga.actualizar(
      "Creando productos en Rappi",
      "Las imágenes se procesaron. Rappi está registrando los productos."
    );
    try {
      await continuarYCcrearProductos();
    } finally {
      progresoCarga.quitar();
    }
    return {
      paso: "productos_creados_pendiente_asociacion",
      mensaje: `Rappi procesó las imágenes y creó los productos. La asociación queda pendiente para que la realices por separado. ${traza}`,
    };
  }
  progresoCarga.quitar();
  if (r.estado === "pagina_404") {
    // Rappi muestra esta pantalla como una falla visual de su propia
    // app justo después de recibir el ZIP, pero el archivo sí se sube
    // y se procesa bien del lado del servidor — confirmado a mano:
    // recargando la pestaña (F5) aparecen los productos con sus
    // imágenes ya cargadas. El problema es que no sabemos cuánto
    // tarda ese procesamiento real en terminar (sigue corriendo en el
    // servidor aunque la vista esté rota), así que no basta una
    // recarga a tiempo fijo: se usa el esquema de reintentos con
    // espera de un minuto (ver revisarReintento404AlCargar arriba),
    // que vuelve a comprobar una vez si la vista sigue rota.
    sessionStorage.setItem(CLAVE_REINTENTO_404, "1");
    mostrarProgresoEsperaRecarga();
    timerReintento404 = setTimeout(() => location.reload(), ESPERAS_REINTENTO_404_MS[0]);
    return {
      paso: "imagenes_pagina_404",
      mensaje: "Las imágenes se están procesando. Puedes seguir el progreso en la pestaña de Mi Tienda.",
    };
  }
  if (r.estado === "error_rappi") {
    return {
      paso: "imagenes_error_rappi",
      mensaje: `Rappi rechazó el ZIP (peso/formato) a los ${r.segundos}s. ${traza}`,
    };
  }
  return {
    paso: "imagenes_sin_terminar",
    mensaje: `Pasaron ${r.segundos}s (10 min máx.) y Rappi no mostró éxito ni error. ${traza}`,
  };
}

function mostrarProgresoCargaImagenes() {
  const overlay = document.createElement("div");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    display: "grid",
    placeItems: "center",
    padding: "20px",
    background: "rgba(15, 23, 42, 0.28)",
    pointerEvents: "none",
  });

  const tarjeta = document.createElement("div");
  Object.assign(tarjeta.style, {
    width: "min(520px, calc(100vw - 40px))",
    padding: "24px",
    border: "1px solid #d8dee8",
    borderRadius: "10px",
    background: "#fff",
    boxShadow: "0 8px 28px rgba(0, 0, 0, 0.25)",
    color: "#222",
    font: "16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    textAlign: "center",
  });

  const titulo = document.createElement("div");
  titulo.textContent = "Cargando imágenes para crear productos";
  titulo.style.fontWeight = "600";

  const detalle = document.createElement("div");
  detalle.textContent = "Rappi está procesando las imágenes. Esta operación puede tardar varios minutos.";
  detalle.style.margin = "6px 0 18px";

  const pista = document.createElement("div");
  Object.assign(pista.style, {
    height: "20px",
    overflow: "hidden",
    borderRadius: "999px",
    background: "#e5e7eb",
  });
  pista.setAttribute("role", "progressbar");
  pista.setAttribute("aria-label", "Rappi está procesando las imágenes");
  pista.setAttribute("aria-valuetext", "Procesando imágenes");

  const progreso = document.createElement("div");
  Object.assign(progreso.style, {
    width: "38%",
    height: "100%",
    borderRadius: "inherit",
    background: "#2c7be5",
  });
  pista.appendChild(progreso);
  tarjeta.append(titulo, detalle, pista);
  overlay.appendChild(tarjeta);
  document.body.appendChild(overlay);

  const animacion = progreso.animate(
    [{ transform: "translateX(-110%)" }, { transform: "translateX(270%)" }],
    { duration: 1300, iterations: Infinity, easing: "ease-in-out" }
  );

  return {
    actualizar(nuevoTitulo, nuevoDetalle) {
      titulo.textContent = nuevoTitulo;
      detalle.textContent = nuevoDetalle;
    },
    quitar() {
      animacion.cancel();
      overlay.remove();
    },
  };
}

function mostrarProgresoEsperaRecarga() {
  const contenedor = document.createElement("div");
  contenedor.setAttribute("role", "status");
  contenedor.setAttribute("aria-live", "polite");
  Object.assign(contenedor.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    zIndex: "2147483647",
    width: "min(520px, calc(100vw - 32px))",
    padding: "24px",
    border: "1px solid #d8dee8",
    borderRadius: "10px",
    background: "#fff",
    boxShadow: "0 8px 28px rgba(0, 0, 0, 0.25)",
    color: "#222",
    font: "16px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  });

  const titulo = document.createElement("div");
  titulo.textContent = "Preparando la creación de productos";
  titulo.style.fontWeight = "600";

  const detalle = document.createElement("div");
  detalle.textContent = "Espera mientras Mi Tienda se actualiza.";
  detalle.style.margin = "4px 0 12px";

  const pista = document.createElement("div");
  Object.assign(pista.style, {
    height: "20px",
    overflow: "hidden",
    borderRadius: "999px",
    background: "#e5e7eb",
  });
  pista.setAttribute("role", "progressbar");
  pista.setAttribute("aria-label", "Espera para continuar con la creación");
  pista.setAttribute("aria-valuemin", "0");
  pista.setAttribute("aria-valuemax", "100");

  const progreso = document.createElement("div");
  Object.assign(progreso.style, {
    width: "0%",
    height: "100%",
    borderRadius: "inherit",
    background: "#2c7be5",
    transition: "width 250ms linear",
  });
  pista.appendChild(progreso);
  contenedor.append(titulo, detalle, pista);
  document.body.appendChild(contenedor);
  barraProgresoReintento404 = contenedor;

  const inicio = Date.now();
  const actualizarProgreso = () => {
    const proporcion = Math.min(
      1,
      (Date.now() - inicio) / DURACION_BARRA_REINTENTO_404_MS
    );
    const porcentaje = Math.floor(proporcion * 100);
    progreso.style.width = `${porcentaje}%`;
    pista.setAttribute("aria-valuenow", String(porcentaje));

    if (proporcion === 1) {
      clearInterval(intervaloProgresoReintento404);
      intervaloProgresoReintento404 = null;
    }
  };

  actualizarProgreso();
  intervaloProgresoReintento404 = setInterval(actualizarProgreso, 250);
}

async function continuarYCcrearProductos() {
  const drawer = Array.from(document.querySelectorAll(SELECTOR_DRAWER))
    .find((elemento) => elemento.offsetParent !== null);
  if (drawer) {
    const botonContinuar = await esperarBotonContinuarDrawer(drawer, 120000);
    if (!botonContinuar) {
      throw new Error('Las imágenes se procesaron, pero "Continuar" no se habilitó en el panel de carga.');
    }
    botonContinuar.click();
  }

  const botonCrear = await esperarBotonHabilitadoConTexto(TEXTO_BOTON_CREAR_PRODUCTOS, 120000);
  if (!botonCrear) {
    throw new Error('No apareció el botón habilitado "Crear productos" después de cargar las imágenes.');
  }
  botonCrear.click();

  const pantallaAsociacion = await esperarBotonPorTexto(TEXTO_BOTON_ASOCIAR_PRODUCTOS, 120000);
  if (!pantallaAsociacion) {
    throw new Error(
      'Se pulsó "Crear productos", pero Mi Tienda no confirmó que la creación terminó. Revisa el estado de la página; la asociación no se inició.'
    );
  }
}

function normalizarTexto(t) {
  return (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function describirTraza(r) {
  const prog = r.progresos.length
    ? "Progreso observado: " + r.progresos.map((p) => `${p.pct} (${p.segundos}s)`).join(" → ") + "."
    : "No se observó ninguna barra de progreso.";
  const url = r.cambioUrl
    ? ` La URL cambió a ${r.cambioUrl.url} a los ${r.cambioUrl.segundos}s.`
    : " La URL no cambió.";
  return prog + url;
}

/**
 * Sondea la pantalla cada 500 ms hasta ver: éxito ("Carpeta cargada con
 * éxito" / "Procesamiento completado"), error de Rappi (peso/formato),
 * página 404, o agotar el tiempo. Registra porcentajes y cambios de URL.
 */
function esperarResultadoProcesamientoZip(timeoutMs) {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const urlInicial = location.href;
    let cambioUrl = null;
    const progresos = [];

    const terminar = (estado) => {
      clearInterval(intervalo);
      clearTimeout(timer);
      resolve({ estado, segundos: Math.round((Date.now() - inicio) / 1000), cambioUrl, progresos });
    };

    const intervalo = setInterval(() => {
      const segundos = Math.round((Date.now() - inicio) / 1000);
      if (!cambioUrl && location.href !== urlInicial) cambioUrl = { url: location.href, segundos };

      const pct = Array.from(document.querySelectorAll(".progress-bar-title"))
        .map((e) => e.textContent.trim())
        .filter(Boolean)
        .join(" / ");
      if (pct && progresos[progresos.length - 1]?.pct !== pct) progresos.push({ pct, segundos });

      const texto = normalizarTexto(document.body?.innerText);
      if (texto.includes("pagina no encontrada")) return terminar("pagina_404");
      if (texto.includes("carpeta cargada con exito") || texto.includes("procesamiento completado")) {
        return terminar("exito");
      }
      if (texto.includes("verifica que el peso de cada imagen")) return terminar("error_rappi");
    }, 500);

    const timer = setTimeout(() => terminar("timeout"), timeoutMs);
  });
}

// ---------------- Utilidades de archivos ----------------

function base64AArchivo(base64, nombre, tipoMime) {
  const binario = atob(base64);
  const buffer = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) buffer[i] = binario.charCodeAt(i);
  return new File([buffer], nombre, { type: tipoMime, lastModified: Date.now() });
}

function asignarArchivosAInput(input, archivos) {
  const dt = new DataTransfer();
  archivos.forEach((a) => dt.items.add(a));
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
  if (setter) {
    setter.call(input, dt.files);
  } else {
    input.files = dt.files;
  }
  // Solo se dispara "change" — igual que una selección real de archivo
  // en el navegador. Antes también se disparaban "input" y un focus()
  // previo; si el manejador de Rappi no es idempotente, procesar el
  // mismo archivo dos veces podía dejar su estado interno roto casi
  // al instante (consistente con el crash a 1s, sin cambio de URL,
  // que se observó en pruebas).
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function esperarArchivosAsignados(input, timeoutMs) {
  return new Promise((resolve) => {
    const intervalo = setInterval(() => {
      if (input.files?.length > 0 && input.files[0].size > 0) {
        clearInterval(intervalo);
        clearTimeout(timer);
        resolve(input.files[0]);
      }
    }, 100);
    const timer = setTimeout(() => {
      clearInterval(intervalo);
      resolve(null);
    }, timeoutMs);
  });
}

// ---------------- Búsqueda de elementos por texto ----------------

function buscarElementoPorTexto(selector, texto, ambito) {
  const elementos = (ambito || document).querySelectorAll(selector);
  for (const el of elementos) {
    // El mismo texto puede aparecer en botones de pasos anteriores que
    // Angular no elimina del DOM, solo oculta. offsetParent === null
    // es una forma simple y barata de detectar "no visible" (display:
    // none, o un ancestro oculto) y así no hacer clic en un botón de
    // una pantalla ya superada.
    if (el.offsetParent === null) continue;
    if (el.textContent && el.textContent.trim().includes(texto)) return el;
  }
  return null;
}

function buscarBotonPorTextoEnAmbito(ambito, texto) {
  const directo = buscarElementoPorTexto("button, [role='button']", texto, ambito);
  if (directo) return directo;
  // A veces el texto vive en un <span> hijo del botón real.
  const span = buscarElementoPorTexto("span", texto, ambito);
  return span ? span.closest("button, [role='button']") : null;
}

function buscarBotonContinuarDrawer(ambito) {
  const botones = ambito.querySelectorAll("button");
  return Array.from(botones).find((boton) => {
    const texto = (boton.textContent || "").trim();
    return boton.offsetParent !== null && texto.includes(TEXTO_BOTON_CONTINUAR) && !boton.disabled;
  }) || null;
}

function esperarBotonContinuarDrawer(drawer, timeoutMs) {
  return new Promise((resolve) => {
    const intervalo = setInterval(() => {
      const boton = buscarBotonContinuarDrawer(drawer);
      if (boton) {
        clearInterval(intervalo);
        clearTimeout(timer);
        resolve(boton);
      }
    }, 300);
    const timer = setTimeout(() => {
      clearInterval(intervalo);
      resolve(null);
    }, timeoutMs);
  });
}

function buscarBotonPorTexto(texto) {
  return buscarBotonPorTextoEnAmbito(document, texto);
}

// ---------------- Esperas (MutationObserver / polling) ----------------

function esperarSelector(selector, timeoutMs) {
  return new Promise((resolve) => {
    const existente = document.querySelector(selector);
    if (existente) return resolve(existente);

    const observer = new MutationObserver(() => {
      const encontrado = document.querySelector(selector);
      if (encontrado) {
        observer.disconnect();
        resolve(encontrado);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

function esperarElementoPorTexto(selector, texto, timeoutMs) {
  return new Promise((resolve) => {
    const existente = buscarElementoPorTexto(selector, texto);
    if (existente) return resolve(existente);

    const observer = new MutationObserver(() => {
      const encontrado = buscarElementoPorTexto(selector, texto);
      if (encontrado) {
        observer.disconnect();
        resolve(encontrado);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

function esperarBotonPorTexto(texto, timeoutMs) {
  return new Promise((resolve) => {
    const existente = buscarBotonPorTexto(texto);
    if (existente) return resolve(existente);

    const observer = new MutationObserver(() => {
      const encontrado = buscarBotonPorTexto(texto);
      if (encontrado) {
        observer.disconnect();
        resolve(encontrado);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}

function esperarBotonHabilitadoConTexto(texto, timeoutMs) {
  return new Promise((resolve) => {
    const intervalo = setInterval(() => {
      const boton = buscarBotonPorTexto(texto);
      if (boton && !boton.disabled) {
        clearInterval(intervalo);
        clearTimeout(timer);
        resolve(boton);
      }
    }, 300);
    const timer = setTimeout(() => {
      clearInterval(intervalo);
      resolve(null);
    }, timeoutMs);
  });
}

/**
 * Espera a que un elemento (por selector) exista Y no esté deshabilitado
 * (propiedad .disabled), sondeando cada 300ms — más confiable que un
 * MutationObserver de atributos cuando Angular controla el estado
 * mediante bindings.
 */
/**
 * Espera a que se habilite "Continuar" en la pantalla de la
 * plantilla, O a que la pantalla ya haya avanzado sola a la de
 * imágenes (Rappi a veces salta directo sin un clic explícito, y en
 * ese caso el botón de la plantilla desaparece del DOM antes de que
 * lo alcancemos a ver habilitado).
 */
function esperarContinuarPlantillaOAvance(timeoutMs) {
  return new Promise((resolve) => {
    const intervalo = setInterval(() => {
      const boton = document.querySelector(SELECTOR_BOTON_CONTINUAR_PLANTILLA);
      if (boton && !boton.disabled) {
        clearInterval(intervalo);
        clearTimeout(timer);
        resolve({ tipo: "boton", el: boton });
        return;
      }
      const estado = detectarEstadoDelFlujo();
      if (estado?.tipo === "imagenes") {
        clearInterval(intervalo);
        clearTimeout(timer);
        resolve({ tipo: "avanzo" });
      }
    }, 300);
    const timer = setTimeout(() => {
      clearInterval(intervalo);
      resolve(null);
    }, timeoutMs);
  });
}

function esperarBotonHabilitado(selector, timeoutMs) {
  return new Promise((resolve) => {
    const intervalo = setInterval(() => {
      const el = document.querySelector(selector);
      if (el && !el.disabled) {
        clearInterval(intervalo);
        clearTimeout(timer);
        resolve(el);
      }
    }, 300);
    const timer = setTimeout(() => {
      clearInterval(intervalo);
      resolve(null);
    }, timeoutMs);
  });
}

/** Igual que esperarBotonHabilitado, pero buscando por texto dentro de un ámbito. */
function esperarBotonHabilitadoPorTexto(ambito, texto, timeoutMs) {
  return new Promise((resolve) => {
    const intervalo = setInterval(() => {
      const el = ambito.querySelector(SELECTOR_DRAWER)
        ? buscarBotonContinuarDrawer(ambito)
        : buscarBotonPorTextoEnAmbito(ambito, texto);
      if (el && !el.disabled) {
        clearInterval(intervalo);
        clearTimeout(timer);
        resolve(el);
      }
    }, 300);
    const timer = setTimeout(() => {
      clearInterval(intervalo);
      resolve(null);
    }, timeoutMs);
  });
}
