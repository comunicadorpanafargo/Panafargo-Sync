# Panafargo Sync 4.1.8

Extensión de Chrome para consultar publicaciones de Shopify, revisar sus datos y preparar su creación y asociación en Rappi. Conserva el trabajo al cerrar o recargar la ventana; **Nuevo lote** lo reinicia explícitamente.

## SKU base y publicación

| SKU completo de Shopify | Producto base | Identidad para Rappi e inventario |
| --- | --- | --- |
| `11351/MoveForward` | `11351` | `11351/MoveForward` |
| `11351/YourDream` | `11351` | `11351/YourDream` |
| `10498-1/Femenino` | `10498-1` | `10498-1/Femenino` |
| `10498-1/Masculino` | `10498-1` | `10498-1/Masculino` |

Solo el texto anterior a la primera `/` se usa para comparar y contar productos base. Los guiones se conservan: `10498` y `10498-1` son referencias diferentes. Para almacenar, seleccionar, exportar y asociar se usa siempre el **SKU completo**.

- Una búsqueda por base encuentra todas sus publicaciones, recorriendo las páginas de Shopify y descartando coincidencias parciales.
- Una búsqueda por SKU completo conserva únicamente esa publicación.
- Cada base se consulta una vez por proceso, aunque se peguen varios de sus diseños.
- El límite es de **10 bases**, que pueden representar **14 o más publicaciones**. El sistema no recorta silenciosamente las líneas.
- Si el mismo SKU completo aparece en variantes distintas de Shopify, queda bloqueado para resolver la ambigüedad; no se suman inventarios ni se elige uno al azar.

## Instalación

1. Crea `shopify/config.js` a partir de `shopify/config.example.js` y configura la tienda y la aplicación de Shopify. Este archivo está excluido de Git; no publiques credenciales.
2. La aplicación de Shopify necesita estar instalada en esa tienda y tener habilitada la lectura de productos. El módulo obtiene y almacena temporalmente el access token mediante `client_credentials`.
3. En Chrome, abre `chrome://extensions`, activa el modo desarrollador y carga esta carpeta como extensión descomprimida.
4. Abre Panafargo Sync desde su icono. Las bibliotecas de Excel y ZIP ya están incluidas; la extensión no necesita una instalación con npm.

Al actualizar la extensión, conserva tu `shopify/config.js`, recarga la extensión en `chrome://extensions` y recarga también Mi Tienda (F5). La cabecera permite comprobar la versión instalada y el envío exige la misma versión en Mi Tienda. Vuelve a **Buscar y validar** los productos guardados por versiones anteriores: sus galerías estaban limitadas a dos fotos y no se usan para crear un lote incompleto.

## Flujo para el usuario

### 1. Revisar productos

Pega los códigos y pulsa **Buscar y validar**. Cada publicación tiene su tarjeta con imagen, SKU completo, base, existencias, disponibilidad para Rappi y los datos pendientes. La foto propia de la variante tiene prioridad sobre la imagen general del producto.

El resumen distingue productos base, publicaciones, listas y pendientes. Una base con diseños publicados no se marca como faltante por no existir un SKU idéntico a la base. **Reintentar pendientes** vuelve a consultar solo lo que necesita revisión. El reporte CSV es opcional: no se descarga un archivo cada vez que buscas.

### 2. Preparar Rappi

Las publicaciones listas se seleccionan automáticamente y las elecciones se conservan por SKU completo. Puedes desmarcar las que no quieres incluir. Los bloqueos siguen visibles y no pueden seleccionarse.

- **Crear productos:** genera una sola vez el Excel y el ZIP de carga masiva. Espera que Chrome confirme ambas descargas completas y entonces abre **Cárgalas aquí** en Rappi y adjunta ese mismo ZIP automáticamente. Si falla una descarga, no envía el lote. Debes tener tu sesión iniciada en Mi Tienda.
- El ZIP incluye la principal como `SKU.ext` y todas las secundarias de Shopify como `SKU_1.ext`, `SKU_2.ext`, etc. Las secundarias son obligatorias cuando existen: una foto fallida detiene la preparación e identifica SKU y posición, sin omitirla. No se exige inventar una secundaria si Shopify solo tiene una foto. La galería se consulta hasta su última página.
- Se observa el procesamiento nativo antes de continuar con la creación existente. El 100 % de transferencia o un botón Continuar habilitado no se toman como éxito. Se muestran los errores de procesamiento del panel actual y se conserva la asociación final como tarea independiente.
- Los SKU con `/` o `\\` quedan **pendientes** en esta entrega: desmárcalos para crear los demás. No desvían el lote a la carga individual ni cambian de código.
- **Refrescar Rappi** descarta el borrador anterior de Mi Tienda y abre la entrada oficial para una plantilla nueva. Borra selección, mensajes y plantilla de asociación locales; vuelve a mostrar los productos fuente desmarcados. Conserva los productos, conteos, contexto, equivalencias y credenciales de Shopify, y la sesión de Rappi. No elimina productos ya creados en el servidor.
- Se retiraron **Retomar lote abierto** y los dos botones separados de descarga y preparación. Si todavía existe una revisión anterior, usa **Refrescar Rappi** antes de crear otro lote.
- No se aceptan envíos simultáneos mientras se está procesando un lote o esperando el reintento de Rappi.
- Mi Tienda permanece visible durante la subida, el procesamiento y la creación. Desde 4.1.6 se retiró la pantalla de espera de la extensión para poder observar los mensajes y controles nativos de Rappi. La recuperación automática existente conserva sus tiempos y su recorrido.
- Refrescar comprueba todas las pestañas de Mi Tienda antes de descartar el borrador. Si hay una operación activa o no puede confirmar la versión y el estado de una pestaña, detiene la limpieza. Una pestaña que siga ejecutando código antiguo debe actualizarse con F5 tras recargar la extensión.

### Estado de las imágenes

La versión 4.1.7 recupera el recorrido masivo de 4.0.0 para los SKU compatibles y conserva el diseño actual. El ZIP descargado sí es importable y solo contiene fotos con los nombres esperados por Rappi; no es el antiguo respaldo con mapas y nombres hash. Se mantienen JPG/PNG/WEBP de hasta 1 MB por imagen, sin ampliar artificialmente las fotos.

En 4.1.8 se comprobó el vínculo entre el SKU de la columna D y los nombres del ZIP: `4354323-1` produce `4354323-1.jpg`, `4354323-1_1.jpg`, etc. El guion forma parte del SKU; el guion bajo identifica la secundaria. La carga se limita al selector ZIP del panel masivo abierto mediante **Cárgalas aquí**, el mismo control que utiliza **Subir archivo**. No se adjunta al primer selector ZIP de toda la página. Un panel ambiguo detiene el envío. La [auditoría del vínculo y del control nativo](docs/vinculacion-imagenes-rappi.md) documenta la comprobación.

El tratamiento automático de `/` queda pendiente por decisión del usuario. Esos SKU siguen disponibles para consulta, inventario y asociación por su código completo; no se crea un lote nuevo con ellos desde este botón. Los módulos experimentales individuales se conservan para la investigación, fuera del recorrido de la interfaz.

La comparación histórica, el alcance y las recomendaciones están en [docs/carga-masiva-rappi-4.1.7.md](docs/carga-masiva-rappi-4.1.7.md). Las pruebas locales y el frontend público no demuestran una subida real en la cuenta privada; esa verificación debe hacerse observando un lote pequeño en Mi Tienda.

### 3. Asociar

Selecciona la plantilla `.xlsx` que Rappi envía para el lote; se valida y guarda automáticamente, sin un botón Guardar. Una nueva plantilla válida reemplaza la anterior, incluidos su archivo y nombre. Si no es válida, se conserva la plantilla actual. El nombre vigente aparece en pantalla y se recupera al volver a abrir la extensión. También puedes volver a seleccionar un archivo actualizado que conserve el mismo nombre.

**Descargar precios y existencias** completa únicamente las filas seleccionadas, encontrándolas por SKU completo en la columna G con el prefijo `PANAFARGOSAS_`.

- K: precio calculado.
- N: unidades disponibles después de la reserva.
- Los identificadores, descripciones, descuento y disponibilidad de las filas seleccionadas se conservan.
- Las filas ajenas al lote se eliminan del archivo generado para evitar actualizar otros productos.
- No se sustituye un diseño ausente por su base. Se informa cada SKU completo que no tenga fila en la plantilla.
- Los espacios exteriores del Excel se ignoran al buscar, conservando las celdas e identificadores originales. Los SKU duplicados se rechazan. Una plantilla guardada dañada no se cambia silenciosamente por otra con identificadores distintos.

Sube el archivo generado en Mi Tienda, revísalo y confirma allí la asociación. La extensión no pulsa ese botón final ni recibe tu contraseña de Rappi.

## Inventario y precio

### Existencias

El inventario se lee de `inventoryQuantity` de la variante exacta de Shopify. Para los SKU con `/`, ese dato es el **conteo manual registrado en Shopify por publicación**. No se toma de Webcol, de un archivo de productos ni del inventario de la base, y no se distribuye una cantidad compartida entre diseños.

Se mantiene la reserva existente: menos de 50 unidades → `floor(inventario / 3)`; desde 50 → `floor(inventario / 2)`. Por ejemplo, dos diseños con 3 y 6 unidades producen 1 y 2 unidades para Rappi, respectivamente. El redondeo hacia abajo corresponde a cantidades de inventario, no al precio.

### Precio

P es el precio normal de Shopify: `compareAtPrice` si supera `price`; en los demás casos, `price`.

- Hasta **$444.500 inclusive**: `(P × 0,80) ÷ 0,70`.
- Por encima de **$444.500**: `(P × 0,90) ÷ 0,70`.
- Solo el resultado final se redondea **hacia arriba** al siguiente múltiplo de $100, conservando los múltiplos exactos. Se usa aritmética entera.

$350.000 produce $400.000; $516.700 produce $664.400. Al preparar el lote se recalcula el precio para no exportar un valor anterior guardado. El cálculo local no publica cambios sobre el catálogo existente de Rappi.

## Verificación

Con Node.js 24, desde la raíz:

```bash
node --test tests/*.test.mjs
```

Las pruebas usan datos simulados y las bibliotecas y plantillas reales del repositorio: SKU, paginación, conteos, inventario separado, reserva, precios, imágenes, Excel y límites de automatización. No necesitan credenciales ni crean productos en Shopify o Rappi. La comprobación del portal real requiere una sesión autorizada y un lote de prueba revisado por el usuario.

## Mantenimiento y expansión

`utils/sku.js` y `utils/lote.js` contienen identidad, agrupación y coordinación reutilizables. Shopify es la fuente; `rappi/` conserva las categorías, reserva, formato Excel y automatización específicos del destino. La estructura y los siguientes pasos para Mercado Libre están descritos en [docs/flujo-y-expansion.md](docs/flujo-y-expansion.md).

El catálogo conserva las 987 categorías y equivalencias de peso utilizadas. Marca y EAN quedan vacíos en la plantilla de creación conforme a las reglas existentes. Peso ausente, inventario inválido, imagen ausente o SKU ambiguo bloquean la publicación. Si Rappi cambia sus pantallas o plantillas, deben comprobarse contra el portal real antes de modificar selectores o formatos.
