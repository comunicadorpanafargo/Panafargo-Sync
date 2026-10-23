const KEY_VENTANA_POPUP = "panafargo_popup_window_id";

chrome.action.onClicked.addListener(async () => {
  const popupUrl = chrome.runtime.getURL("popup/popup.html");
  const ventanas = await chrome.windows.getAll({ populate: true });
  const ventanaExistente = ventanas.find((ventana) =>
    ventana.tabs?.some((tab) => tab.url === popupUrl)
  );

  if (ventanaExistente?.id) {
    await chrome.windows.update(ventanaExistente.id, { focused: true });
    await chrome.storage.session.set({ [KEY_VENTANA_POPUP]: ventanaExistente.id });
    return;
  }

  const ventana = await chrome.windows.create({
    type: "popup",
    url: popupUrl,
    width: 420,
    height: 700,
  });
  await chrome.storage.session.set({ [KEY_VENTANA_POPUP]: ventana.id });
  await limpiarSesionRappi();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const { [KEY_VENTANA_POPUP]: popupWindowId } = await chrome.storage.session.get(KEY_VENTANA_POPUP);
  if (windowId !== popupWindowId) return;

  await chrome.storage.local.remove(["panafargo_productos", "panafargo_matriz_v11"]);
  await chrome.storage.session.remove(KEY_VENTANA_POPUP);
  await limpiarSesionRappi();
});

async function limpiarSesionRappi() {
  const tabs = await chrome.tabs.query({ url: "https://mitienda.rappi.com.co/*" });
  await Promise.all(
    tabs.map(async (tab) => {
      try {
        await chrome.tabs.sendMessage(tab.id, { tipo: "RAPPI_LIMPIAR_SESION" });
      } catch (err) {
        console.warn(`[Panafargo Sync] No se pudo limpiar la sesión Rappi de la pestaña ${tab.id}.`, err);
      }
    })
  );
}
