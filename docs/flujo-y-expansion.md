# Flujo, limpieza y expansión

## Cambios de interfaz

Las capturas originales mostraban tablas de cinco y seis columnas dentro de una ventana estrecha, códigos partidos, acciones deshabilitadas sin suficiente contexto y un botón «Extraer SKU» que acababa descargando una matriz. Los pasos de creación y asociación tampoco quedaban suficientemente diferenciados.

Se implementaron tres pasos con nombres de tarea: revisar, preparar y asociar. Las tarjetas conservan legibles los SKU completos, explican los bloqueos y separan el inventario de origen de la cantidad disponible para Rappi. El resumen usa unidades de conteo explícitas. La ventana es más amplia y la presentación se adapta también a tamaños pequeños.

Se eliminaron clics intermedios: no hay validación individual separada, los resultados se preparan automáticamente, las publicaciones listas aparecen seleccionadas y la plantilla de asociación se guarda al elegirla. Crear productos descarga el Excel y un respaldo de imágenes, espera a que terminen y empieza la carga. Se conservan el lote y las selecciones al recargar. Existe un refresco explícito y reintento solo de pendientes.

Las capturas aportadas se revisaron. El MP4 y el ZIP de la grabación superaron el límite de transferencia de32MiB y no pudieron inspeccionarse; no se atribuyen observaciones adicionales al video.

## Botones necesarios y acciones secundarias

El camino principal es **Buscar y validar → Crear productos → seleccionar la plantilla recibida → Descargar precios y existencias**. Elegir la plantilla ya la valida y guarda. La creación y la confirmación final de asociación siguen siendo pasos distintos. Desde 4.1.7 se usa el ZIP masivo con principal y todas las secundarias; los SKU con `/` quedan pendientes y deben desmarcarse para crear los demás.

| Control actual | Utilidad | Decisión recomendada |
| --- | --- | --- |
| **Buscar y validar** | Esencial: consulta Shopify y revisa cada publicación. | Mantener como acción principal del paso 1. |
| **Continuar a Rappi** y pestañas de pasos | Navegación, sin una nueva consulta ni publicación por sí misma. | Conservar un avance claro y la posibilidad de volver. «Continuar» puede retirarse si el acceso al paso 2 sigue siendo evidente; no eliminar la navegación de recuperación. |
| **Crear productos** | Genera Excel e imágenes, descarga el respaldo y espera ambas descargas completas antes del envío a Mi Tienda. | Acción única del paso 2. Sustituye preparación y descarga separadas. |
| **Seleccionar todas** y casillas por publicación | Permiten excluir y volver a incluir SKU completos sin borrar datos ni repetir la consulta. | Mantener; reemplazan la antigua X para quitar productos. |
| **Seleccionar plantilla (.xlsx)** | Esencial para usar el archivo de asociación del lote real. | Mantener el selector. El guardado tras validar ya es automático. |
| **Descargar precios y existencias** | Esencial en la asociación actual: produce el archivo completado que se sube y revisa en Rappi. | Mantener. Es el antiguo «Descargar plantilla generada» con un nombre que explica su resultado. |
| **Descargar reporte CSV** | Registro de resultados y diagnóstico; no crea ni asocia productos. | Opcional. Puede ir en opciones secundarias, sin convertir la descarga en requisito. |
| **Reintentar pendientes** | Recuperación de consultas fallidas o publicaciones corregidas en Shopify. | Mantener y mostrar o habilitar solo cuando existan pendientes; no obligar a repetir todo el lote. |
| **Nuevo lote** | Reinicia explícitamente la selección y revisión locales. | Mantener como acción secundaria, separada del envío al portal. |
| **Refrescar Rappi** | Descarta el borrador del portal, vuelve a una plantilla nueva y limpia selección, mensajes y plantilla de Rappi. | Mantener arriba del paso 2; conserva Shopify y la sesión del usuario, y bloquea el borrado durante operaciones activas. |

Los controles redundantes de las capturas antiguas ya no forman parte de la interfaz actual:

- **Cargar productos validados:** la preparación se actualiza al terminar la búsqueda y al entrar en los pasos siguientes.
- **Guardar plantilla:** se sustituyó por validación y guardado al seleccionar el archivo.
- **Validar individualmente**, **Buscar un SKU** y **Descargar imagen individual** como recorridos separados: el lote atiende también una sola referencia, sin repetir pantallas ni descargas por producto.
- **X para quitar:** se sustituyó por desmarcar la publicación; se conserva la posibilidad de recuperarla en el mismo lote.
- **Subir una plantilla de asociación sin completar:** no sustituye la generación de precios y existencias ni la revisión final del usuario.
- **Retomar lote abierto:** retirado; para otro intento se descarta el borrador mediante Refrescar Rappi.
- **Descargar lote e imágenes** como botón separado: incluido en Crear productos, sin repetir consultas de imágenes.

El respaldo se conserva automáticamente aunque se retire el botón separado de descarga. El inventario anterior se basa en el código del checkout y su flujo local. No demuestra que se haya ejecutado una creación o asociación en el portal real de Rappi.

## Código depurado

- Pantalla individual sin acceso desde la navegación y sus listeners.
- Controles de categorías inalcanzables, descarga individual del flujo de lote y subida oculta de la plantilla de asociación sin transformar.
- Funciones de almacenamiento, marcas, historial y esperas sin consumidores; declaración duplicada de un helper del portal.
- Arrays de marcas y unidades que no usaba ningún módulo: se retiraron aproximadamente200KB sin cambiar las987 categorías ni4 equivalencias de peso activas.
- Permiso `windows` innecesario y exposición web de una plantilla que solo necesita leer la propia extensión.

Se mantiene un único cálculo de precio, la reserva existente y las plantillas del repositorio. La búsqueda agrupa consultas por base y el almacenamiento guarda el lote completo de forma atómica. Ni la clave del almacenamiento ni las existencias se agrupan por base.

## Límites que deben verificarse en Rappi

El SKU con `/` se conserva en consultas, inventario y asociación. El algoritmo privado que vincula nombres de ZIP no está confirmado para esos identificadores. En 4.1.7 su creación queda pendiente y se prioriza el recorrido masivo de los demás SKU, con todas sus fotos. El ZIP descargado ahora sí es el importable enviado a Mi Tienda. La comparación y sus límites están en [carga-masiva-rappi-4.1.7.md](carga-masiva-rappi-4.1.7.md); [rappi-imagenes-por-sku.md](rappi-imagenes-por-sku.md) conserva la investigación histórica del recorrido individual.

No se reanuda una revisión antigua con imágenes de un lote nuevo. Se rechazan cargas simultáneas o durante el reintento activo de Rappi. Se conserva la confirmación final de asociación en el portal.

## Próximas mejoras por prioridad

1. **Comprobar principal y secundarias del ZIP en una cuenta real.** Verificar un lote pequeño antes de aumentar el volumen. El recorrido de `/` queda pendiente. No confundir ensayos locales con publicaciones reales ya realizadas.
2. **Historial de trabajos y prevención de reenvíos.** Identificador de lote, estado por publicación y comprobación del resultado antes de permitir repetir una creación. Requiere una señal fiable del portal; una descarga o un botón pulsado no prueba publicación.
3. **Reintentos por fallos recuperables.** Reintentar imágenes o consultas fallidas con límites, evitando repetir creaciones ya confirmadas. Mostrar fase y pendientes, con cancelación segura antes de enviar.
4. **Importación de inventario con reglas explícitas.** Si se incorpora Webcol, solo actualizar referencias base autorizadas. Una fila base nunca debe sobrescribir el conteo manual de un SKU con `/`; cualquier actualización de Shopify debe ser una operación separada y revisable.

## Incorporar Mercado Libre sin duplicar el sistema

La identidad compartida debe mantener SKU completo, base, variante y producto de origen, imágenes propias, precio normal e inventario de origen. La preparación de un lote recibe la búsqueda, normalización y validación como funciones; no necesita conocer credenciales ni el formato del marketplace.

Cada destino debe implementar su propia validación, precio, stock disponible, categoría, atributos, exportación o API y resultado verificable. La reserva de Rappi, su prefijo de asociación y su Excel no deben convertirse en reglas de Mercado Libre. Tampoco debe bloquearse un producto para todos los destinos solo porque le falte un campo exclusivo de Rappi.

Para Mercado Libre faltan una conexión OAuth autorizada, renovación segura de credenciales, elección de sitio, categorías y atributos obligatorios, política de variantes/publicaciones, SKU del vendedor, precio, existencias y reglas para crear o actualizar sin duplicados. La implementación debe comenzar con validación y vista previa; después, publicación explícita y trazabilidad de los identificadores remotos.

No se añadieron botones ficticios de Mercado Libre ni se inventaron endpoints o permisos. El adaptador se puede incorporar manteniendo el flujo compartido y las pruebas de identidad e inventario.
