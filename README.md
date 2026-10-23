# Panafargo Sync — V1.0 / V1.1 / V2 / V4

Extensión de Chrome que consulta productos de Shopify por SKU, los valida (imagen obligatoria), genera el lote listo para Rappi y puede subirlo directamente en el portal real de Rappi ("Mi Tienda"), usando tu propia sesión ya iniciada.

---

## 🔑 Credenciales de Shopify

**Viven en un único archivo:** `shopify/config.js` (no se sube al repo — está en `.gitignore`; la plantilla pública es `shopify/config.example.js`).

Desde enero de 2026, las apps creadas en el **Dev Dashboard** de Shopify ya no entregan un token permanente para copiar y pegar. En su lugar, guardas tu **Client ID + Client Secret** y `shopify/shopify-api.js` los intercambia automáticamente por un access token temporal (`client_credentials grant`, expira ~24h), cacheándolo en `chrome.storage.local`.

Requisitos para que el intercambio funcione (si ves error `app_not_installed` o un 400 del endpoint de token):

1. La app debe estar **instalada en esa tienda específica** (Dev Dashboard → tu app → Overview → link de instalación).
2. Debe existir una **versión publicada ("Release")** con el scope `read_products` habilitado.
3. La tienda debe pertenecer a tu misma organización de desarrollador.

**Importante:** Rappi **no** tiene una API pública para el flujo de "Mi Tienda" (carga por lotes personalizados). Por eso V4 no usa credenciales de Rappi en absoluto — automatiza el formulario real usando la sesión que ya iniciaste tú mismo en el navegador (ver más abajo).

---

## Estructura del proyecto

```
panafargo-sync/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.css
│   ├── popup.js
│   └── rappi-ui.js                 ← pestaña "Preparar Rappi (V2 / V4)"
├── shopify/
│   ├── config.example.js
│   ├── config.js                     ← ⚠️ credenciales reales, NO se sube
│   └── shopify-api.js
├── rappi/
│   ├── rappi-catalog.js              ← catálogos REALES de Rappi (987 categorías, 15.688 marcas, 10 unidades)
│   ├── rappi-connector.js            ← transforma PanafargoProduct → modelo Rappi + validación
│   ├── rappi-batch.js                ← genera el .xlsx real y lo descarga
│   ├── rappi-images-zip.js           ← arma el .zip de imágenes para Mi Tienda (V4)
│   ├── mi-tienda-content-script.js   ← automatiza el formulario real de Mi Tienda (V4)
│   └── plantilla-rappi-base.xlsx     ← plantilla oficial de Rappi, sin el producto de ejemplo
├── images/
│   └── image-handler.js
├── storage/
│   └── storage.js                    ← productos, matriz V1.1, equivalencias, trazabilidad
├── utils/
│   ├── model.js
│   └── logger.js
├── vendor/
│   ├── xlsx.full.min.js              ← SheetJS, genera el .xlsx en el navegador
│   └── jszip.min.js                  ← JSZip, arma el .zip de imágenes en el navegador
└── icons/
```

## Uso — V1.0 (búsqueda individual)

Sin cambios: pestaña **"Buscar 1 SKU"**.

## Uso — Procesar hasta 10 productos

Pega hasta **10 SKU**, uno por línea, y pulsa **"Procesar y descargar matriz (.csv)"**. El campo muestra las líneas numeradas del 1 al 10, indica cuántos SKU distintos se ingresaron y no permite superar las diez líneas. La matriz muestra y descarga todos los productos: marca como bloqueados los que no cumplen los requisitos de Rappi (incluido peso/unidad faltante o inventario negativo) y detalla el motivo. Solo los productos en `OK` quedan disponibles en **Preparar Rappi**.

## Uso — V2 (preparar el lote)

1. Valida al menos un producto en las pestañas V1.0/V1.1.
2. Ve a **"Preparar Rappi (V2)"** → **"Cargar productos validados"**. Puedes pulsarlo de nuevo tras validar más SKU: agrega los nuevos a la lista y conserva los ya cargados y seleccionados. Usa **"Todos"** en el encabezado para seleccionar/deseleccionar los productos listos, o marca solo los que necesites. Los productos incompletos no se pueden seleccionar.
3. Cada producto se transforma automáticamente usando **solo datos de Shopify** (nombre, categoría estándar —`category.fullName`— o, si falta, tipo de producto —`productType`—, descripción y peso). El SKU es el único dato manual — lo usaste para buscar el producto, y vuelve a usarse aquí como identificador de la fila y del archivo de imagen.
4. La **categoría se asigna automáticamente**: el sistema compara la categoría de Shopify contra las opciones reales del catálogo de Rappi y elige la mejor coincidencia por palabras en común, guardándola para reutilizarla. Si no encuentra una coincidencia válida o falta categoría, usa **"Papelería y oficina > Papelería > Otros Papelería"**. La marca es opcional y se deja en blanco en la plantilla.
5. El precio de asociación se calcula al consultar y preparar cada producto, usando el precio normal de Shopify (`compareAtPrice` si es mayor que el precio actual; de lo contrario, `price`). Hasta **$444.500 inclusive**, se resta **20 %**; por encima de ese valor, se resta **10 %**. El importe resultante se divide entre **0,70** y solo entonces se redondea hacia arriba al siguiente múltiplo de **$100** (si ya es múltiplo exacto, se conserva). La fórmula es `100 × ceil((precioBase × factor) / (0,70 × 100))`, con factor `0,80` o `0,90`, usando aritmética entera para evitar errores de precisión. Por ejemplo, $350.000 da $400.000 y $516.700 da $664.400. Al preparar productos ya cargados se recalcula el precio; el Excel de asociación usa ese resultado actualizado. Este cálculo local no publica cambios en los precios existentes de Rappi.
6. **"Descargar lote (.xlsx)"** — respaldo local: descarga `Panafargo_Rappi/Lotes/lote_rappi_{fecha}.xlsx` (igual a la plantilla oficial) y la imagen de cada producto en `Panafargo_Rappi/Imagenes/{sku}.jpg`.
7. La X junto al SKU lo quita de la lista de esta sesión. Los productos procesados se olvidan al cerrar la ventana de la extensión.

## Uso — V4 (subida directa a Rappi)

1. Abre **Mi Tienda** (`mitienda.rappi.com.co`) en otra pestaña e inicia sesión con tu usuario normal. No hace falta navegar tú por el flujo — la extensión lleva la pestaña directo a `cms/catalog/bulk-creation/manual/1` si detecta que no estás ya ahí.
2. En el popup de la extensión, con los productos ya cargados (paso V2), haz clic en **"Subir directamente a Rappi (Mi Tienda)"**.
3. La extensión genera la plantilla `.xlsx` y un `.zip` con las imágenes (nombradas por SKU, como exige Rappi — ver "Reglas fijas") y se los envía a un *content script* que recorre las 6 pantallas reales del flujo, una detrás de otra, sin recargar la página:
   1. **"Crea tus productos"** → clic en **"Personalizados"**.
   2. **"Crea productos personalizados"** (introducción) → clic en su **"Subir plantilla"** (ese botón solo navega, no contiene el archivo).
   3. **"Sube la plantilla"** → coloca el `.xlsx` en el input real, espera a que Rappi valide el archivo y habilite **"Continuar"**, y hace clic.
   4. Pantalla de revisión → clic en **"¿Prefieres cargar múltiples imágenes a la vez? Cárgalas aquí"**.
   5. En el panel que se abre → coloca el `.zip`, espera a que se habilite su **"Continuar"** (puede tardar según cuántas imágenes traiga). Mientras Rappi procesa las imágenes aparece una barra de carga grande y centrada; al terminar, la extensión continúa automáticamente.
   6. Tras procesar las imágenes, la extensión pulsa **"Continuar"** y **"Crear productos"**. Se detiene en la pantalla de asociación; no pulsa **"Asociar productos"**.
4. Si Mi Tienda muestra temporalmente "página no encontrada" durante la carga, la extensión indica que las imágenes siguen subiendo, actualiza la pestaña en un minuto y, si la pantalla se recuperó, continúa con la creación. Si no se recupera, revisa Mi Tienda y continúa manualmente.

### Por qué V4 funciona así (y no por API)

Investigué la API pública de Rappi (`dev-portal.rappi.com`): existe, pero es para gestión de **menús de restaurantes con pedidos en vivo** (requiere registro como "Rappi Aliado" y credenciales OAuth separadas) — no aplica al flujo de carga por lotes personalizados de "Mi Tienda", que no tiene API pública documentada. Automatizar eso a ciegas (adivinando endpoints internos) habría violado la regla del propio proyecto de no inventar el comportamiento del portal real (ver más abajo, "Reglas fijas"). Por eso V4 automatiza el **formulario visible**, con selectores confirmados contra el HTML real de las 6 pantallas de Mi Tienda, usando tu sesión ya iniciada — nunca credenciales.

## Reglas fijas de este proyecto

- **¿Es pesable?** y **¿Es preempaquetado?** siempre se exportan como `NO`.
- **Cantidad** y **Unidad de medida** salen del peso registrado en Shopify (`inventoryItem.measurement.weight`); si el producto no tiene peso, queda bloqueado para Rappi.
- Los productos con inventario no disponible o negativo también quedan bloqueados; corrige el dato en Shopify y vuelve a procesar el SKU.
- **EAN** queda fuera del proyecto en todas las versiones.
- La categoría se valida contra el catálogo real embebido en `rappi/rappi-catalog.js` — nunca se inventan valores. La columna opcional de marca de la plantilla oficial se conserva vacía.
- El SKU liga la búsqueda en Shopify (V1.0), la fila del producto en el lote (V2) y el nombre del archivo dentro del .zip de imágenes (V4).
- La extensión **nunca** pide, recibe ni guarda tu usuario/contraseña de Rappi — V4 solo interactúa con el DOM de una pestaña donde tú ya iniciaste sesión.
- La creación de productos y la asociación son procesos independientes. La subida directa crea los productos y se detiene antes de **"Asociar productos"**; el usuario realiza la asociación por separado.

### Si Rappi actualiza su plantilla, catálogos o el diseño de Mi Tienda

- Catálogos/plantilla: regenerar `rappi/rappi-catalog.js` y `rappi/plantilla-rappi-base.xlsx` desde el Excel nuevo — no editar esos archivos a mano.
- Diseño de Mi Tienda: los selectores de las 6 pantallas están documentados al inicio de `rappi/mi-tienda-content-script.js`; si Rappi cambia el HTML de alguna, hay que volver a capturar el HTML real de esa pantalla (clic derecho → Inspeccionar → Copy outerHTML) y actualizar su selector — no hay forma de saberlo sin verlo, así que este archivo es el primero en romperse si Rappi rediseña el flujo.

## Qué NO incluye esta versión

- Confirmar automáticamente la asociación de productos: la plantilla queda cargada y el usuario revisa y pulsa el botón final en Mi Tienda.
- Gestión avanzada de imágenes, deduplicación, historial persistente → **V3** (no implementado).
- Reintentos automáticos o reanudar una subida a medio camino si Mi Tienda fallara o cambiara de pantalla — hoy se detiene y reporta el paso exacto para continuar a mano.

## Pruebas del precio

Con Node.js 24, ejecuta `node --test tests/precios-rappi.test.mjs` desde la raíz del repositorio. Las pruebas comprueban la fórmula, el precio normal frente a rebajas de Shopify, los límites de $444.500, productos con un precio calculado anterior y el Excel de asociación. Usan datos locales simulados, sin credenciales ni solicitudes a Shopify o Rappi.
