# Comparación de versiones y corrección del flujo

Revisión del 29 de octubre de 2026. Se compararon el historial Git, las plantillas y el frontend público de Mi Tienda; no se usaron credenciales ni se crearon productos reales.

## Versiones revisadas

| Commit | Versión | Cambio principal |
| --- | --- | --- |
| `373627f` | 4.0.0 inicial | Recorrido de creación original. |
| `9944342` | 4.0.0 | Fórmula de precio aprobada. |
| `90a8b93` | 4.1.0 | SKU completos, diseños e interfaz guiada. |
| `5169dde` | 4.1.1 | Espera de creación y guardado automático de asociación. |
| `0add13a` | 4.1.2 | Imágenes por fila para `/` y reinicio local. |
| `ea7f8fa` | 4.1.3 | Reanudación y protección frente a una creación sin confirmar. |

## Datos esenciales conservados

- `rappi-batch.js`, ambas plantillas XLSX, SheetJS y JSZip son idénticos entre las seis versiones. El Excel de creación conserva B–K desde la fila 6; la asociación mantiene SKU en G, precio en K y unidades en N.
- SHA-256 de la plantilla de creación: `7645a722541c2231c079f22d488eeb3ad9591def81bf017e45bcb618c8c8be51`. Asociación: `304948d58df0b84f22280cb721840bca26c6e3fcd690e155cc42133304dab27a`.
- Se conservaron las 987 categorías y las cuatro equivalencias de peso. Los arrays retirados de marcas y unidades no tenían consumidores activos.
- Desde `9944342` se conserva el precio normal de Shopify: hasta $444.500 inclusive, `P × 0,80 ÷ 0,70`; por encima, `P × 0,90 ÷ 0,70`. El resultado se redondea hacia arriba a $100.
- La reserva sigue siendo `floor(stock / 3)` por debajo de 50 y `floor(stock / 2)` desde 50. Cada diseño usa el conteo de su variante exacta de Shopify; no el de la base ni Webcol.
- El SKU completo identifica publicaciones, fotos y asociación. Solo el conteo y la búsqueda agrupan por lo anterior a la primera `/`; los guiones siguen siendo parte del código.
- La autenticación no se sustituyó durante los cambios de imágenes. `shopify/config.js` sigue ignorado y fuera del repositorio. No cambian dominios ni permisos de Chrome en 4.1.4.

La pantalla individual retirada no tenía acceso desde la navegación. El botón antiguo de subir una asociación sin completar ya estaba oculto en 4.0.0. Ninguno explica el error de las filas de imágenes.

## Problemas encontrados y cambios de 4.1.4

1. **Entrada en la revisión sin un archivo válido.** La URL anterior terminaba en `/bulk-creation/manual/1`. El controlador oficial usa esa ruta para revisar el ID almacenado en `ean-match-creation-file-id`. Abrirla sin un ID válido puede mostrar el título sin productos. Ahora se entra por `/bulk-creation/home-manual` y el formulario oficial de carga.
2. **Reinicio incompleto.** 4.1.2/4.1.3 limpiaban la extensión pero conservaban el borrador y la vista de Rappi. Refrescar ahora comprueba las pestañas, descarta solo el ID de borrador y las marcas propias, vuelve al inicio de carga y limpia la preparación local. Conserva sesión, tokens y los datos de Shopify. No elimina publicaciones del servidor.
3. **Acciones fragmentadas.** Se retiran Retomar y los botones separados de descarga y preparación. Crear productos construye un solo lote, conserva su Excel y respaldo y entonces empieza el envío.
4. **Una descarga iniciada no es una descarga completa.** La API de Chrome entrega un ID al empezar. Ahora se espera `state: complete` de ambos archivos; una descarga cancelada o fallida impide cargar el lote. Los bytes de las fotos preparados para Rappi se reutilizan en el respaldo.
5. **Diagnóstico de tabla vacía.** El error de la captura ocurrió con cero imágenes confirmadas, antes de pulsar Crear. La espera pasa de 20 a 60 segundos y distingue entre revisión vacía y tabla ausente. La comprobación exacta del SKU y la confirmación de imagen siguen siendo obligatorias.

La captura por sí sola no demuestra si el portal rechazó el Excel, todavía procesaba el archivo o conservaba una revisión sin productos. No se eliminan controles de identidad ni se pulsa Crear ignorando ese error. Volver íntegramente a 4.0.0 reintroduciría los falsos faltantes por `/` y los nombres interpretados como rutas dentro del ZIP.

## Fuentes y límites

Las rutas, el ID de borrador, los controles de imagen y la paginación se observan en el [bundle oficial de catálogo](https://mfe-partner-catalog.rappi.com.co/509.575c148061339d05.js). El [remote entry](https://mfe-partner-catalog.rappi.com.co/mfePartnerCatalog.js), consultado nuevamente el 29/10/2026, conserva ese hash. Las [traducciones oficiales](https://mitienda.rappi.com.co/assets/i18n/es-CO.json) confirman Crear productos y Asociar productos.

El ejemplo de configuración conserva una versión antigua de la API de Shopify desde antes de estas modificaciones. No se inspeccionó la configuración privada ni la versión efectiva de respuesta. No explica que, en la captura, la consulta de ambos diseños ya hubiera terminado correctamente.

Las pruebas locales comprueban archivos reales del repositorio y un DOM basado en los controles públicos, con productos e imágenes sintéticos. La creación y asociación en la cuenta privada siguen requiriendo comprobar el resultado en Mi Tienda. Descartar el borrador no cancela una creación que ya se haya enviado al servidor.
