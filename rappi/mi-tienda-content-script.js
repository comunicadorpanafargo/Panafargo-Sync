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
const CLAVE_CREACION_PENDIENTE = "panafargoSync:creacionPendiente";
const ESPERAS_REINTENTO_404_MS = [60000]; // 1 minuto, un solo intento de recarga
let timerReintento404 = null;
let subidaEnCurso = false;

const TEXTO_BOTON_ASOCIAR_PRODUCTOS = "Asociar productos";

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
  subidaEnCurso = true;
  sessionStorage.removeItem(CLAVE_REINTENTO_404);
  try {
    await continuarYCcrearProductos();
  } catch (err) {
    console.error("No se pudo continuar la creación de productos tras la recarga:", err);
  } finally {
    subidaEnCurso = false;
  }
})();

chrome.runtime.onMessage.addListener((mensaje, _sender, sendResponse) => {
  if (mensaje?.tipo === "RAPPI_ESTADO_CARGA") {
    sendResponse({
      ok: true,
      cargaEnCurso: subidaEnCurso || sessionStorage.getItem(CLAVE_REINTENTO_404) !== null,
      versionExtension: chrome.runtime.getManifest?.().version || null,
      imagenesPorSku: Boolean(globalThis.PanafargoImagenesPorSku),
      reiniciarPreparacion: true,
      estadoFlujo: detectarEstadoDelFlujo()?.tipo || null,
    });
    return;
  }

  if (mensaje?.tipo === "RAPPI_REINICIAR_PREPARACION") {
    const cargaEnCurso = subidaEnCurso || sessionStorage.getItem(CLAVE_REINTENTO_404) !== null;
    if (cargaEnCurso) {
      sendResponse({ ok: false, cargaEnCurso: true, error: "Mi Tienda todavía está procesando un lote. Espera el resultado antes de refrescar Rappi." });
      return;
    }
    try {
      // Solo el borrador de creación. No se borran sesión, cookies, tokens,
      // productos del catálogo ni publicaciones ya creadas en el servidor.
      globalThis.localStorage?.removeItem("ean-match-creation-file-id");
      sessionStorage.removeItem(CLAVE_REINTENTO_404);
      sessionStorage.removeItem(CLAVE_CREACION_PENDIENTE);
      clearTimeout(timerReintento404);
      timerReintento404 = null;
      sendResponse({ ok: true, reiniciado: true });
    } catch (error) {
      sendResponse({ ok: false, error: `No se pudo descartar el borrador de Rappi. ${error.message}` });
    }
    return;
  }

  if (mensaje?.tipo === "RAPPI_SUBIR_LOTE") {
    if (subidaEnCurso || sessionStorage.getItem(CLAVE_REINTENTO_404) !== null) {
      sendResponse({
        ok: false,
        error: "Ya hay una carga de productos en curso o una recuperación pendiente. Espera a que termine y revisa Mi Tienda antes de iniciar otro lote.",
      });
      return;
    }
    subidaEnCurso = true;
    (async () => {
      let respuesta;
      try {
        respuesta = { ok: true, ...await ejecutarSubida(mensaje) };
      } catch (err) {
        respuesta = { ok: false, error: err.message };
      } finally {
        subidaEnCurso = false;
      }
      sendResponse(respuesta);
    })();
    return true; // indica respuesta asíncrona
  }

});

async function ejecutarSubida({
  xlsxBase64,
  xlsxNombre,
  imagenesZipBase64,
  imagenesZipNombre,
  imagenesPorSku,
  imagenesManualesPorSku = false,
  reanudarRevision,
  skus = [],
}) {
  let etapa = "inicio";
  try {
    etapa = "plantilla";
    return await ejecutarSubidaPorEtapas(
      { xlsxBase64, xlsxNombre, imagenesZipBase64, imagenesZipNombre, imagenesPorSku, imagenesManualesPorSku, reanudarRevision, skus },
      (nombreEtapa) => { etapa = nombreEtapa; }
    );
  } catch (err) {
    throw new Error(`Fallo en la etapa ${etapa}: ${err.message}`);
  }
}

async function ejecutarSubidaPorEtapas(
  { xlsxBase64, xlsxNombre, imagenesZipBase64, imagenesZipNombre, imagenesPorSku, imagenesManualesPorSku = false, reanudarRevision, skus = [] },
  establecerEtapa
) {
  if (reanudarRevision === true) {
    throw new Error("La opción de retomar fue retirada. Actualiza la extensión y pulsa Refrescar Rappi para descartar el borrador anterior; después usa Crear productos.");
  }
  let paquetePorSku;
  if (imagenesPorSku !== undefined) {
    if (!globalThis.PanafargoImagenesPorSku) {
      throw new Error("Recarga la pestaña de Mi Tienda para activar la carga de imágenes por SKU completo.");
    }
    // Comprobar el mapa entero antes de cargar incluso el Excel.
    paquetePorSku = PanafargoImagenesPorSku.validar(imagenesPorSku, skus);
  }
  if (normalizarTexto(document.body?.innerText).includes("pagina no encontrada")) {
    throw new Error(
      'La pestaña de Mi Tienda ya estaba mostrando "página no encontrada" antes de empezar. Pulsa Refrescar Rappi para volver a la carga de una plantilla nueva.'
    );
  }

  const estadoInicial = await esperarEstadoDelFlujo(20000);
  if (estadoInicial?.tipo === "imagenes") verificarCreacionPendiente();
  if (estadoInicial?.tipo === "imagenes") {
    return {
      paso: "revision_lote_existente",
      plantillaSubida: false,
      productosPublicados: false,
      mensaje: "Mi Tienda conserva una revisión de imágenes anterior. Pulsa Refrescar Rappi para descartarla y volver a la carga de plantilla; después selecciona las publicaciones y usa Crear productos. No se enviaron imágenes ni se pulsó Crear productos.",
    };
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

  if (paquetePorSku) {
    const revision = await esperarEstadoDelFlujo(20000, "imagenes");
    if (!revision) throw new Error("No se confirmó la revisión de imágenes. No se pulsó Crear productos.");
    return asignarImagenesPorSkuYCrear(paquetePorSku, establecerEtapa);
  }

  if (imagenesManualesPorSku) {
    establecerEtapa("revision_imagenes_manuales");
    const revision = await esperarEstadoDelFlujo(20000, "imagenes");
    if (!revision) {
      throw new Error(
        "Se cargó la plantilla, pero no se confirmó la pantalla de revisión de imágenes. Revisa Mi Tienda; no se cargaron imágenes ni se pulsó Crear productos."
      );
    }
    return resultadoImagenesManuales(skus, true);
  }

  verificarCreacionPendiente({ plantillaNuevaConfirmada: true });
  return subirImagenes(imagenesZipBase64, imagenesZipNombre, establecerEtapa);
}

async function asignarImagenesPorSkuYCrear(paquetePorSku, establecerEtapa) {
  verificarCreacionPendiente({ plantillaNuevaConfirmada: true });
  establecerEtapa("asignar_imagenes_por_sku");
  // La primera pasada comprueba TODAS las páginas
  // antes de adjuntar archivos. No basta con que coincida una fila visible.
  const resultado = await PanafargoImagenesPorSku.asignar(paquetePorSku);
  establecerEtapa("crear_productos");
  await continuarYCcrearProductos();
  return {
    paso: "productos_creados_pendiente_asociacion",
    plantillaSubida: true,
    imagenesSubidas: resultado.imagenesSubidas,
    skus: resultado.skus,
    mensaje: `Mi Tienda confirmó ${resultado.imagenesSubidas} imágenes por SKU completo y la creación de los productos. La asociación queda pendiente: usa la plantilla enviada por Rappi y revisa sus filas antes de confirmarla allí.`,
  };
}

function resultadoImagenesManuales(skus, plantillaSubida) {
  const skusCompletos = Array.isArray(skus)
    ? [...new Set(skus.filter((sku) => typeof sku === "string" && sku.length > 0))]
    : [];
  const detalleSku = skusCompletos.length ? ` SKU completos: ${skusCompletos.join(", ")}.` : "";
  return {
    paso: "imagenes_manuales_por_sku",
    plantillaSubida,
    productosPublicados: false,
    skus: skusCompletos,
    mensaje: `${plantillaSubida
      ? "Plantilla cargada y revisión de imágenes disponible."
      : "Mi Tienda ya estaba en revisión de imágenes; no se volvió a cargar la plantilla. Verifica que corresponda a este lote."} Asigna las imágenes manualmente a cada SKU completo y revisa los productos antes de continuar en Mi Tienda.${detalleSku} La extensión no pulsó Crear productos ni Asociar productos.`,
  };
}

function detectarEstadoDelFlujo() {
  const enlace = buscarElementoPorTexto("a, button, [role='button']", TEXTO_LINK_MULTIPLES_IMAGENES);
  const inputZip = document.querySelector(SELECTOR_INPUT_ZIP);
  const tituloRevision = buscarElementoPorTexto("h1, h2, h3, p", TEXTO_TITULO_REVISION_IMAGENES);
  if (enlace || inputZip || tituloRevision) return { tipo: "imagenes", enlace, inputZip };

  if (
    document.querySelector(SELECTOR_INPUT_PLANTILLA) ||
    document.querySelector(SELECTOR_BOTON_PERSONALIZADOS) ||
    document.querySelector(SELECTOR_BOTON_IR_A_SUBIR_PLANTILLA)
  ) {
    return { tipo: "plantilla" };
  }
  return null;
}

function esperarEstadoDelFlujo(timeoutMs, tipoEsperado = null) {
  return new Promise((resolve) => {
    const revisar = () => {
      const estado = detectarEstadoDelFlujo();
      return !tipoEsperado || estado?.tipo === tipoEsperado ? estado : null;
    };
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
  const r = await esperarResultadoProcesamientoZip(600000);
  const traza = describirTraza(r);

  if (r.estado === "exito") {
    establecerEtapa("crear_productos");
    await continuarYCcrearProductos();
    return {
      paso: "productos_creados_pendiente_asociacion",
      mensaje: `Rappi procesó las imágenes y creó los productos. La asociación queda pendiente para que la realices por separado. ${traza}`,
    };
  }
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

async function continuarYCcrearProductos() {
  verificarCreacionPendiente();
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
  // El clic puede llegar al servidor aunque se agote la espera de la vista.
  // Conservar la marca incluso tras F5 evita repetir una creación incierta.
  sessionStorage.setItem(CLAVE_CREACION_PENDIENTE, JSON.stringify({ fileId: obtenerIdLoteRappi() }));
  botonCrear.click();

  const pantallaAsociacion = await esperarBotonPorTexto(TEXTO_BOTON_ASOCIAR_PRODUCTOS, 120000);
  if (!pantallaAsociacion) {
    throw new Error(
      'Se pulsó "Crear productos", pero Mi Tienda no confirmó que la creación terminó. Revisa el estado de la página; la asociación no se inició.'
    );
  }
  sessionStorage.removeItem(CLAVE_CREACION_PENDIENTE);
}

function obtenerIdLoteRappi() {
  try {
    const id = JSON.parse(globalThis.localStorage?.getItem("ean-match-creation-file-id") || "null");
    if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id);
    if (typeof id === "string" && id.trim()) return id.trim();
    return null;
  } catch { return null; }
}

function verificarCreacionPendiente({ plantillaNuevaConfirmada = false } = {}) {
  const pendiente = sessionStorage.getItem(CLAVE_CREACION_PENDIENTE);
  if (pendiente === null) return;
  let anterior;
  try { anterior = JSON.parse(pendiente)?.fileId; } catch { /* Marca ilegible: no repetir el clic. */ }
  const actual = obtenerIdLoteRappi();
  // El ID de localStorage es compartido por las pestañas de Rappi. Un cambio
  // allí no demuestra que ESTA vista haya cambiado: exigir además que este
  // envío haya cargado una plantilla nueva y confirmado su avance.
  if (plantillaNuevaConfirmada && anterior && actual && anterior !== actual) {
    sessionStorage.removeItem(CLAVE_CREACION_PENDIENTE);
    return;
  }
  throw new Error("Ya se pulsó Crear productos para este lote, pero no se confirmó el resultado. Revisa en Mi Tienda si terminó la creación o si Rappi informó un error antes de repetirla. No se volvieron a enviar imágenes ni se pulsó Crear productos otra vez. Para comenzar un lote distinto, carga una plantilla nueva en Mi Tienda.");
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
