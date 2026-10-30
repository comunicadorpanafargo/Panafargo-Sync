# Panafargo Sync — nueva base funcional pendiente

Por instrucción del usuario, se retiró de `main` la implementación anterior. La siguiente base será la versión funcional que entregue el usuario. El repositorio todavía no contiene una extensión instalable.

La versión anterior 4.1.8 se conserva en la etiqueta [respaldo/4.1.8-antes-reemplazo-2026-10-30](https://github.com/comunicadorpanafargo/Panafargo-Sync/tree/respaldo/4.1.8-antes-reemplazo-2026-10-30), correspondiente al commit `51fe5c1a2cfe4d9088c404f82e2385cff785d8e1`.

## Único cambio previsto en la nueva base: precio al asociar

Se aplicará la fórmula una sola vez desde el precio normal de Shopify, antes de escribir el precio en la plantilla de asociación de Rappi. En la implementación anterior ese destino es la columna **K** de la hoja **Productos**; se comprobará contra la versión funcional recibida.

`P` es el precio normal de Shopify: `compareAtPrice` si supera `price`; en los demás casos, `price`. No se toma un precio promocional como base cuando existe un precio normal superior.

| Precio normal P | Descuento | Operación antes de redondear |
| --- | --- | --- |
| Hasta $444.500 inclusive | 20 % | `(P × 0,80) ÷ 0,70` |
| Más de $444.500 | 10 % | `(P × 0,90) ÷ 0,70` |

Solo el resultado final se redondea **hacia arriba al siguiente múltiplo de $100**. Los múltiplos exactos se conservan.

```text
Si P <= 444500: precioRappi = 100 × ceil(P × 8 / 700)
Si P >  444500: precioRappi = 100 × ceil(P × 9 / 700)
```

Equivalente con enteros, para un precio base entero en pesos:

```js
const multiplicador = P > 444500 ? 9n : 8n;
const precioRappi = ((BigInt(P) * multiplicador + 699n) / 700n) * 100n;
```

Ejemplos: $350.000 → $400.000; $516.700 → $664.400; $444.500 → $508.000. Un resultado previo al redondeo de $1.345 pasa a $1.400.

La nueva implementación conservará el recorrido de imágenes, creación e inventario de la versión funcional entregada. El precio se calculará desde su fuente, evitando aplicarlo de nuevo sobre un precio ya transformado.

`shopify/config.js` continúa excluido de Git. No se deben incluir credenciales al entregar o importar la nueva base.
