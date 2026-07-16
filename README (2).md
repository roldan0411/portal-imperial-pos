# Portal Imperial · Sistema POS

Sistema de punto de venta (POS) para **Portal Imperial** — Comida China, Floridablanca (Colombia).
Plan **Profesional**: pedidos (mesa/llevar/domicilio), caja con reglas de efectivo colombianas,
pantalla de cocina (KDS), impresión de comandas y facturas, reportes, inventario con recetas,
auditoría y sincronización en tiempo real entre varios dispositivos.

Desarrollado por **WALLACE COMPANY SYSTEM** — Ing. Roldán Aldana · wallacecompany11@gmail.com

---

## 1. Archivos del sistema

| Archivo | Para qué sirve |
|---|---|
| `index.html` | La página principal. Es la que se abre en el navegador. |
| `app.js` | Toda la lógica del sistema (no se toca, salvo los datos del negocio). |
| `firebase-config.js` | Las llaves para la sincronización. **Aquí pegas tus credenciales.** |
| `logo.js` | El logo del restaurante. |
| `package.json` / `render.yaml` | Para publicar el sistema en internet. |

---

## 2. Usuarios de prueba

| Usuario | Contraseña | Rol |
|---|---|---|
| admin | admin123 | Administrador (acceso total) |
| supervisor | super123 | Supervisor |
| jefe | jefe123 | Jefe |
| cajero | caja123 | Cajero |
| mesero | mesa123 | Mesero |
| cocina | coci123 | Cocina |

> **Importante:** al empezar, entra como `admin` y en **Configuración → Usuarios**
> cambia estas contraseñas por unas seguras.

---

## 3. Activar la sincronización (Firebase)

Sin este paso el sistema funciona, pero **solo en el dispositivo donde se abre**
(no se comparten los pedidos entre el celular del mesero, la caja y la cocina).

Para conectar todos los dispositivos:

1. Entra a https://console.firebase.google.com
2. **Agregar proyecto** → nombre `portal-imperial` → Crear.
3. Menú izquierdo: **Compilación → Realtime Database → Crear base de datos**
   → ubicación Estados Unidos → **Modo de prueba**.
4. Rueda de engranaje ⚙ (arriba) → **Configuración del proyecto**.
5. Baja a **Tus apps** → icono **</>** (Web) → registra la app.
6. Firebase te muestra un cuadro `firebaseConfig` con unas llaves.
   Copia esos valores y pégalos en el archivo **`firebase-config.js`**,
   reemplazando los textos que dicen `PEGA_AQUI_...`.
7. Guarda el archivo, súbelo (ver punto 4) y recarga con **Ctrl + Shift + R**.

Cuando esté bien conectado, un pedido tomado en un dispositivo aparece al
instante en la cocina y en la caja.

---

## 4. Publicar en internet (para usarlo desde cualquier dispositivo)

**Opción rápida — Render (gratis):**

1. Sube esta carpeta a un repositorio de GitHub.
2. Entra a https://render.com → **New → Static Site** → conecta tu repositorio.
3. Render detecta el archivo `render.yaml` y lo publica solo. Te da un enlace
   tipo `https://portal-imperial.onrender.com`.
4. Abre ese enlace en la caja, en el celular del mesero y en la pantalla de cocina.

Cada vez que cambies algo:
```
git add .
git commit -m "cambios"
git push
```
y recarga con **Ctrl + Shift + R**.

---

## 5. Reglas de caja (importante para el manejo de efectivo)

El sistema separa **siempre** cuatro cosas distintas:

- **Comida** → es la venta (efectivo / banco / tarjeta).
- **Propina** → es del mesero, no es venta.
- **Domicilio** → es del domiciliario.
- **Recargo del datáfono** → se lo queda el banco, **nunca sale del cajón**.

El **efectivo esperado** se calcula así:
> base inicial + comida pagada en efectivo + entradas − gastos/nómina/retiros
> − (propinas y domicilios que entraron por banco/tarjeta pero se pagan en efectivo).

El recargo del datáfono **no se resta** del efectivo, porque ese dinero no pasa
por el cajón. El botón **🔍 Diagnóstico de efectivo** (solo admin) muestra el
desglose completo si alguna vez la caja no cuadra.

---

## 6. Consejos de uso

- **Abrir caja** al iniciar el día con la base (lo que quedó contado del cierre anterior).
- Los pedidos van a **Cocina** al pulsar *Guardar / Enviar a cocina* (suena una alarma).
- Si a una mesa ya servida le agregan algo, la cocina recibe un aviso dorado
  con **solo lo nuevo** y vuelve a sonar.
- **Reimprimir comanda** (para la cocina) y **reimprimir factura** (para el cliente)
  son botones separados.
- **Cerrar caja** cuenta el efectivo físico y muestra si **cuadra, sobra o falta**.
- Exporta un **respaldo JSON** periódicamente desde *Reportes* o *Configuración*.

---

© WALLACE COMPANY SYSTEM · wallacecompany11@gmail.com
