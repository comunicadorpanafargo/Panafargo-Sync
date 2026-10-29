// Controles comprobados en el frontend público de Mi Tienda el 29/10/2026.
// La fila conserva el SKU completo en su tooltip y su input de imagen usa
// los IDs internos del producto. No se infiere una equivalencia de nombres ZIP.
// Ver docs/rappi-imagenes-por-sku.md para las fuentes y límites de verificación.
globalThis.PanafargoImagenesPorSku = (() => {
  const AMBITO = "app-massive-match-suggestions";
  const FILAS = "tbody.table-body > tr";
  const INPUT = 'app-image-preview input[type="file"]';
  const IMAGEN = "app-image-preview img.product-image";
  const LOADER = "app-image-preview .loader-container";
  const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function validar(imagenes, skus) {
    if (!Array.isArray(imagenes) || !imagenes.length || !Array.isArray(skus) || !skus.length) {
      throw new Error("La asignación individual necesita imágenes y SKU completos del lote.");
    }
    const validos = (sku) => typeof sku === "string" && sku.length > 0 && sku.trim() === sku
      && sku.split("/").every((parte) => parte.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(sku);
    if (skus.some((sku) => !validos(sku)) || new Set(skus).size !== skus.length) {
      throw new Error("El lote contiene SKU vacíos, incompletos o duplicados.");
    }
    const esperados = new Set(skus);
    const archivos = new Map();
    for (const imagen of imagenes) {
      if (!imagen || !validos(imagen.sku) || !esperados.has(imagen.sku) || archivos.has(imagen.sku)) {
        throw new Error("El mapa de imágenes no corresponde exactamente a los SKU completos del lote.");
      }
      if (typeof imagen.nombre !== "string" || !imagen.nombre || /[\/\\\u0000-\u001f\u007f]/.test(imagen.nombre)
        || !["image/jpeg", "image/png"].includes(imagen.tipoMime) || typeof imagen.base64 !== "string" || !imagen.base64) {
        throw new Error(`La imagen del SKU ${imagen.sku} no tiene un archivo JPG/PNG válido.`);
      }
      let binario;
      try { binario = atob(imagen.base64); } catch { throw new Error(`La imagen del SKU ${imagen.sku} está dañada.`); }
      if (!binario.length || binario.length > 1_000_000) {
        throw new Error(`La imagen del SKU ${imagen.sku} debe tener contenido y no superar 1 MB.`);
      }
      const bytes = Uint8Array.from(binario, (letra) => letra.charCodeAt(0));
      archivos.set(imagen.sku, new File([bytes], imagen.nombre, { type: imagen.tipoMime }));
    }
    if (archivos.size !== esperados.size) throw new Error("Faltan imágenes de publicaciones seleccionadas.");
    return { skus: [...skus], archivos };
  }

  function leerPagina() {
    const ambitos = document.querySelectorAll(AMBITO);
    if (!ambitos.length) return null;
    if (ambitos.length !== 1) throw new Error("Hay más de una revisión de productos. No se asignaron imágenes a una fila ambigua.");
    const ambito = ambitos[0];
    const filas = [...ambito.querySelectorAll(FILAS)].map((fila) => {
      const celda = fila.cells?.[1];
      const textos = celda?.querySelectorAll(".tooltip.arrow-bottom");
      const sku = textos?.length === 1 ? textos[0].textContent.trim() : null;
      if (!sku) throw new Error("Mi Tienda no muestra el SKU completo de una fila. Revisa el lote antes de continuar.");
      return { fila, sku };
    });
    const paginadores = ambito.querySelectorAll("app-pagination");
    if (paginadores.length > 1) throw new Error("Mi Tienda muestra varios paginadores de productos.");
    let numero = 1;
    if (paginadores.length) {
      const actuales = paginadores[0].querySelectorAll("li.page.current a");
      const texto = actuales.length === 1 ? actuales[0].textContent.trim() : "";
      // La página 1 solo es implícita cuando no existe paginación. Un
      // marcador perdido no puede ocultar otras páginas durante el preflight.
      if (!/^[1-9]\d*$/.test(texto)) throw new Error("No se pudo identificar la página actual de Mi Tienda.");
      numero = Number(texto);
    }
    if (!Number.isSafeInteger(numero) || numero < 1) throw new Error("No se pudo identificar la página actual de Mi Tienda.");
    return { ambito, filas, numero, firma: JSON.stringify(filas.map(({ sku }) => sku)) };
  }

  function habilitado(enlace) {
    const item = enlace?.closest("li.page");
    return Boolean(enlace && !enlace.hasAttribute("disabled") && enlace.getAttribute("aria-disabled") !== "true"
      && !item?.classList.contains("disabled") && !item?.classList.contains("disabled-visible"));
  }

  async function esperarResultado(comprobar, timeout, intervalo, motivo) {
    const inicio = Date.now();
    do {
      const resultado = comprobar();
      if (resultado) return resultado;
      await espera(intervalo);
    } while (Date.now() - inicio < timeout);
    throw new Error(motivo);
  }

  async function asignar(paquete, {
    alProgreso = () => {}, timeoutPaginaMs = 20000, timeoutImagenMs = 60000, intervaloMs = 150,
  } = {}) {
    const esperados = new Set(paquete.skus);
    const confirmados = new Set();
    const esquema = [];
    let pagina;
    const cargarPagina = () => esperarResultado(() => {
      const actual = leerPagina();
      return actual?.filas.length ? actual : null;
    }, timeoutPaginaMs, intervaloMs, "No aparecieron las filas de imágenes de Mi Tienda.");
    const navegar = async (enlace, destino) => {
      const anterior = pagina;
      enlace.click();
      return esperarResultado(() => {
        const actual = leerPagina();
        return actual?.filas.length && actual.numero === destino && actual.firma !== anterior.firma ? actual : null;
      }, timeoutPaginaMs, intervaloMs, "Mi Tienda no confirmó el cambio de página. No se continuó la creación.");
    };
    try {
      pagina = await cargarPagina();
      // Primera pasada: verificar el lote entero, también las páginas ocultas.
      // Segunda: asignar imágenes solo si el mismo conjunto sigue presente.
      for (const asignando of [false, true]) {
        const paginas = new Set();
        const vistos = new Set();
        let indicePagina = 0;
        if (pagina.numero !== 1) {
          const inicio = pagina.ambito.querySelector("app-pagination a.pagination-start");
          if (!habilitado(inicio)) throw new Error("No se pudo volver al inicio del lote de imágenes.");
          pagina = await navegar(inicio, 1);
        }
        while (true) {
          if (paginas.has(pagina.firma) || paginas.size > paquete.skus.length) throw new Error("Mi Tienda repitió una página del lote.");
          paginas.add(pagina.firma);
          if (asignando) {
            const prevista = esquema[indicePagina];
            if (!prevista || prevista.numero !== pagina.numero || prevista.firma !== pagina.firma) {
              throw new Error("El lote cambió después de comprobar los SKU. No se continuó la creación.");
            }
          } else esquema.push({ numero: pagina.numero, firma: pagina.firma });
          // Validar la página completa antes de asignar su primera imagen.
          const enPagina = new Set();
          for (const { fila, sku } of pagina.filas) {
            if (!esperados.has(sku)) throw new Error(`Mi Tienda muestra un SKU ajeno al lote: ${sku}.`);
            if (enPagina.has(sku) || vistos.has(sku)) throw new Error(`Mi Tienda muestra varias filas para el SKU ${sku}.`);
            enPagina.add(sku);
            const inputs = fila.querySelectorAll(INPUT);
            if (inputs.length !== 1 || inputs[0].disabled) throw new Error(`No hay un único control de imagen disponible para el SKU ${sku}.`);
            if (fila.querySelector(LOADER)) throw new Error(`El SKU ${sku} ya tiene una imagen en procesamiento.`);
            vistos.add(sku);
          }
          if (asignando) for (const { sku } of pagina.filas) {
            const buscar = () => {
              const actual = leerPagina();
              if (!actual || actual.numero !== pagina.numero || actual.firma !== pagina.firma) {
                throw new Error("La revisión cambió mientras se asignaban imágenes. No se continuó la creación.");
              }
              const coincidencias = actual.filas.filter((item) => item.sku === sku);
              if (coincidencias.length !== 1) throw new Error(`No se identificó una fila única para ${sku}.`);
              return coincidencias[0].fila;
            };
            const fila = buscar();
            if (fila.querySelector(LOADER)) throw new Error(`El SKU ${sku} ya tiene una imagen en procesamiento.`);
            const anterior = fila.querySelector(IMAGEN)?.getAttribute("src") || "";
            alProgreso({ sku, completadas: confirmados.size, total: esperados.size });
            const inputs = fila.querySelectorAll(INPUT);
            if (inputs.length !== 1 || inputs[0].disabled) throw new Error(`El control de imagen de ${sku} cambió.`);
            const transferencia = new DataTransfer();
            transferencia.items.add(paquete.archivos.get(sku));
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
            if (setter) setter.call(inputs[0], transferencia.files);
            else inputs[0].files = transferencia.files;
            // El handler oficial vacía el input inmediatamente. No esperar files.length.
            inputs[0].dispatchEvent(new Event("change", { bubbles: true }));
            await esperarResultado(() => {
              const actual = buscar();
              const imagen = actual.querySelector(IMAGEN);
              const src = imagen?.getAttribute("src") || "";
              return src && src !== anterior && /^https?:/i.test(imagen.src)
                && imagen.complete && imagen.naturalWidth > 0 && !actual.querySelector(LOADER);
            }, timeoutImagenMs, intervaloMs, `No se confirmó una imagen nueva para el SKU ${sku}. Revisa el error de Mi Tienda.`);
            confirmados.add(sku);
            alProgreso({ sku, completadas: confirmados.size, total: esperados.size });
          }
          // Angular puede reconstruir nodos al actualizar una imagen; releer el
          // paginador evita hacer clic sobre un enlace que ya salió del documento.
          const actual = leerPagina();
          if (!actual || actual.numero !== pagina.numero || actual.firma !== pagina.firma) {
            throw new Error("La revisión cambió antes de avanzar la página del lote.");
          }
          pagina = actual;
          indicePagina++;
          const siguiente = pagina.ambito.querySelector("app-pagination a.pagination-next");
          if (!habilitado(siguiente)) break;
          pagina = await navegar(siguiente, pagina.numero + 1);
        }
        const faltantes = paquete.skus.filter((sku) => !vistos.has(sku));
        if (faltantes.length) throw new Error(`No aparecieron estas publicaciones en Mi Tienda: ${faltantes.join(", ")}.`);
        if (asignando && indicePagina !== esquema.length) throw new Error("Cambió la paginación del lote después de comprobarlo.");
      }
      return { skus: [...confirmados], imagenesSubidas: confirmados.size };
    } catch (error) {
      throw new Error(`${error.message} Imágenes confirmadas: ${confirmados.size} de ${esperados.size}. No se pulsó Crear productos ni Asociar productos.`);
    }
  }

  return Object.freeze({ validar, asignar });
})();
