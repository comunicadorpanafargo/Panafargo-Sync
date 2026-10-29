// chrome.downloads.download() confirma el inicio, no el archivo terminado.
// Este contrato permite iniciar la carga a Rappi solo después de conservar
// los archivos del lote en el equipo del usuario.
export async function descargarBlobYEsperar(blob, nombre, { timeoutMs = 300000 } = {}) {
  const descargas = globalThis.chrome?.downloads;
  if (!descargas?.download || !descargas.search || !descargas.cancel
    || !descargas.onChanged?.addListener || !descargas.onChanged?.removeListener
    || !descargas.onErased?.addListener || !descargas.onErased?.removeListener) {
    throw new Error("Chrome no permite comprobar la descarga. No se inició la carga a Rappi.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("El tiempo máximo de descarga no es válido.");
  if (typeof nombre !== "string" || !nombre.trim()) throw new Error("La descarga necesita un nombre de archivo.");
  const url = URL.createObjectURL(blob);

  return new Promise((resolve, reject) => {
    let id = null;
    let inicioPendiente = true;
    let finalizado = false;
    let liberado = false;
    let cancelacionPedida = false;
    const previos = new Map();
    const liberar = () => {
      if (liberado) return;
      liberado = true;
      clearTimeout(limite);
      // Una actualización de la extensión puede invalidar el contexto de la
      // API. Aun así hay que liberar la URL que pertenece a esta ventana.
      try { descargas.onChanged.removeListener(alCambiar); } catch { /* Contexto cerrado. */ }
      try { descargas.onErased.removeListener(alBorrar); } catch { /* Contexto cerrado. */ }
      previos.clear();
      URL.revokeObjectURL(url);
    };
    const esTerminal = (estado) => estado === "complete" || estado === "interrupted";
    const detenerYLiberar = () => {
      if (id === null || cancelacionPedida || liberado) return;
      cancelacionPedida = true;
      // Un timeout o un fallo de consulta no demuestra que Chrome haya dejado
      // de leer el Blob. Mantener su URL hasta que se confirme la cancelación
      // o un estado terminal; los listeners también recogen esa confirmación.
      Promise.resolve().then(() => descargas.cancel(id)).then(liberar, async () => {
        try {
          const resultados = await descargas.search({ id });
          const item = resultados?.find((resultado) => resultado.id === id);
          if (!item || esTerminal(item.state)) liberar();
        } catch { /* Conservar la URL hasta un evento terminal de Chrome. */ }
      });
    };
    const fallar = (error, terminado = false) => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(limite);
      if (terminado || (!inicioPendiente && id === null)) liberar();
      else detenerYLiberar();
      reject(error);
    };
    const resolverEstado = (estado, motivo) => {
      if (finalizado) {
        if (esTerminal(estado)) liberar();
        return;
      }
      if (estado === "complete") {
        finalizado = true;
        liberar();
        resolve(id);
      } else if (estado === "interrupted" || motivo) {
        fallar(new Error(`No terminó la descarga de ${nombre}${motivo ? `: ${motivo}` : ". Chrome la interrumpió"}. No se inició la carga a Rappi.`), estado === "interrupted");
      }
    };
    const alCambiar = (cambio) => {
      const estado = cambio.state?.current;
      const motivo = cambio.error?.current;
      if (id === null) {
        if (esTerminal(estado) || motivo) previos.set(cambio.id, { estado, motivo });
      } else if (cambio.id === id) resolverEstado(estado, motivo);
    };
    const alBorrar = (borrado) => {
      if (id === null) previos.set(borrado, { borrado: true });
      else if (borrado === id) fallar(new Error(`Se eliminó la descarga de ${nombre}. No se inició la carga a Rappi.`));
    };
    const limite = setTimeout(() => fallar(new Error(`Chrome no confirmó que terminara la descarga de ${nombre}. No se inició la carga a Rappi.`)), timeoutMs);
    try {
      descargas.onChanged.addListener(alCambiar);
      descargas.onErased.addListener(alBorrar);
    } catch (error) {
      inicioPendiente = false;
      fallar(new Error(`No se pudo observar la descarga: ${error.message || "contexto de Chrome cerrado"}. No se inició la carga a Rappi.`));
      return;
    }

    Promise.resolve().then(() => descargas.download({ url, filename: nombre, saveAs: false })).then(async (descargaId) => {
      inicioPendiente = false;
      if (!Number.isSafeInteger(descargaId) || descargaId < 0) {
        if (finalizado) liberar();
        else fallar(new Error(`Chrome no inició la descarga de ${nombre}. No se inició la carga a Rappi.`));
        return;
      }
      id = descargaId;
      if (finalizado) {
        detenerYLiberar();
        return;
      }
      const anterior = previos.get(id);
      previos.clear();
      if (anterior?.borrado) alBorrar(id);
      else if (anterior) resolverEstado(anterior.estado, anterior.motivo);
      if (finalizado) return;
      try {
        // La consulta cubre eventos que Chrome emitió antes de devolver el ID.
        const resultados = await descargas.search({ id });
        if (finalizado) return;
        const item = resultados?.find((resultado) => resultado.id === id);
        if (!item) {
          fallar(new Error(`Chrome no encuentra la descarga de ${nombre}. No se inició la carga a Rappi.`));
          return;
        }
        resolverEstado(item.state, item.error);
      } catch (error) {
        fallar(new Error(`No se pudo comprobar la descarga de ${nombre}: ${error.message || "error de Chrome"}. No se inició la carga a Rappi.`));
      }
    }, (error) => {
      inicioPendiente = false;
      if (finalizado) liberar();
      else fallar(new Error(`No se pudo iniciar la descarga de ${nombre}: ${error.message || "error de Chrome"}. No se inició la carga a Rappi.`));
    });
  });
}
