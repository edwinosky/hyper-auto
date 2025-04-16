# Monitor y Registrador Automático de Wallets Hyperlane

## Descripción

Este script (`monitor.js`) está diseñado para monitorear el estado de registro de grupos de wallets elegibles asociadas a wallets seguras en la API de Hyperlane (`claim.hyperlane.foundation`). Su objetivo principal es detectar discrepancias entre el estado esperado (definido en `assignment.json`) y el estado real registrado en la API, y **re-registrar automáticamente** los grupos completos si se detectan anomalías.

El script utiliza **Playwright** para conectarse a una instancia de navegador (Chrome/Edge) lanzada manualmente por el usuario. Esta técnica es crucial para intentar **evitar los mecanismos de detección de bots de Vercel**, aprovechando la huella digital y el estado (cookies, etc.) de un navegador real donde el usuario ha superado previamente el "Security Checkpoint" de Vercel de forma manual.

## Problema Solucionado

La API de Hyperlane para el registro de claims está protegida por Vercel, que implementa medidas anti-bot sofisticadas. Un script simple que haga peticiones HTTP directas (como usando `axios` o `fetch` simple desde Node.js) es fácilmente detectado y bloqueado (errores 403 Forbidden).

Este script intenta solucionar esto mediante:

1.  **Conexión a Navegador Existente (CDP):** No lanza un navegador automatizado nuevo (que podría ser detectado), sino que se conecta a tu instancia normal de Chrome/Edge vía `connectOverCDP`, usando el puerto de depuración remota.
2.  **Bypass Manual Inicial:** Requiere que el usuario **primero** lance el navegador con la configuración adecuada (proxy si es necesario) y **navegue manualmente** a la página `claim.hyperlane.foundation` para pasar cualquier desafío de seguridad de Vercel.
3.  **Ejecución de `fetch` en Contexto:** Utiliza `page.evaluate()` para ejecutar las llamadas `fetch` a la API *dentro del contexto de la página* del navegador conectado. Esto intenta hacer que las peticiones parezcan más legítimas y hereden el estado "validado" del navegador.
4.  **Monitoreo y Auto-Corrección:** Comprueba periódicamente los registros y, si detecta diferencias con `assignment.json`, re-registra el grupo completo correspondiente.
5.  **Manejo de Rate Limits:** Implementa un sistema de delay dinámico que aumenta las pausas si se reciben errores `429 Too Many Requests` y las disminuye gradualmente si las operaciones son exitosas.

## Características

*   Conexión a un navegador Chrome/Edge existente vía CDP.
*   Utiliza `page.evaluate(fetch)` para realizar llamadas API desde el contexto del navegador.
*   Requiere bypass manual previo del Vercel Security Checkpoint.
*   Lee la asignación de wallets elegibles a wallets seguras desde `assignment.json`.
*   Obtiene las claves privadas necesarias desde `secure.txt` y `elegibles.txt`.
*   Comprueba los registros existentes en la API de Hyperlane.
*   Compara los registros actuales con los esperados según `assignment.json`.
*   Re-registra automáticamente grupos completos si se detectan anomalías (wallets faltantes, revocadas, destino incorrecto, etc.).
*   Implementa delays aleatorios y un factor de delay dinámico para mitigar rate limits (429).
*   Genera un reporte (`anomaly_report.txt`) con el conteo de anomalías detectadas por wallet segura.

## Prerrequisitos

*   **Node.js:** Versión 16 o superior recomendada.
*   **npm** o **yarn:** Para instalar dependencias.
*   **Navegador Chromium:** Google Chrome o Microsoft Edge instalado.
*   **Proxy Residencial (Muy Recomendado):** Para evitar bloqueos de IP por parte de Vercel.

## Configuración

1.  **Clonar el Repositorio:**
    ```bash
    git clone <url-del-repositorio>
    cd <nombre-del-directorio>
    ```

2.  **Instalar Dependencias:**
    ```bash
    npm install
    ```
    Esto instalará `playwright-extra`, `ethers`. (`fs` y `url` son módulos nativos de Node.js).

3.  **Preparar Archivos de Entrada:** Asegúrate de que los siguientes archivos existan en el mismo directorio que `monitor.js` y tengan el formato correcto:

    *   **`secure.txt`:**
        *   Contiene las **claves privadas** de tus wallets seguras (las que recibirán los fondos/tokens).
        *   Una clave privada por línea.
        *   Puede tener o no el prefijo `0x`. El script lo manejará.
        *   Debe tener 64 caracteres hexadecimales (sin `0x`) o 66 (con `0x`).
        *   Ejemplo:
            ```
            abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
            0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567891
            ```

    *   **`elegibles.txt`:**
        *   Contiene las **claves privadas** de tus wallets elegibles (las que tienen derecho al claim).
        *   Una clave privada por línea.
        *   **IMPORTANTE:** El orden de estas claves debe **corresponder exactamente** al orden de las wallets elegibles dentro de los arrays `eligibleWallets` en `assignment.json` (el script las usa para buscar la clave privada correcta para cada dirección elegible listada en la asignación).
        *   Deben tener el prefijo `0x` y 66 caracteres en total.
        *   Ejemplo:
            ```
            0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd
            0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef12345678
            ```

    *   **`assignment.json`:**
        *   Define qué wallets elegibles están asignadas a cada wallet segura y **con qué monto**. Este archivo es la **fuente de verdad** para la estructura de grupos y los montos.
        *   Debe ser un array JSON de objetos. Cada objeto representa una wallet segura y contiene un array de sus wallets elegibles asignadas.
        *   Formato:
            ```json
            [
              {
                "secureAddress": "0xSECURE_WALLET_ADDRESS_1",
                "eligibleWallets": [
                  { "address": "0xELEGIBLE_WALLET_ADDRESS_A", "amount": "100.596" },
                  { "address": "0xELEGIBLE_WALLET_ADDRESS_B", "amount": "53.650" }
                ]
              },
              {
                "secureAddress": "0xSECURE_WALLET_ADDRESS_2",
                "eligibleWallets": [
                  { "address": "0xELEGIBLE_WALLET_ADDRESS_C", "amount": "45.156" }
                ]
              }
            ]
            ```
        *   El script usará los `amount` de este archivo para los registros.

4.  **Configurar Constantes (Opcional):**
    *   Abre `monitor.js` en un editor.
    *   Puedes ajustar las constantes cerca del inicio del archivo:
        *   `CHECK_INTERVAL`: Tiempo (ms) entre el inicio de cada ciclo de monitoreo/registro.
        *   `BASE_REQUEST_DELAY`: Pausa base (ms) entre el procesamiento de cada wallet segura dentro de un ciclo.
        *   `RANDOM_DELAY_MAX`: Máxima duración aleatoria (ms) añadida a las pausas.
        *   `POST_ACTION_DELAY`: Pausa adicional (ms) aplicada *después* de un intento de registro (POST).
        *   `DEBUGGING_PORT`: El puerto que usarás para lanzar el navegador manualmente. Debe coincidir.
        *   `DEFAULT_CHAIN_ID`: ID de la cadena para la que se registra (ej. 8453 para Base).

## Ejecución (Pasos Críticos)

La ejecución requiere una preparación manual para intentar superar la protección de Vercel:

1.  **Cerrar Navegador:** Cierra **completamente** todas las instancias de Chrome/Edge que no se hayan lanzado con el puerto de depuración.
2.  **Lanzar Navegador Manualmente:** Abre una terminal (CMD, PowerShell, Terminal, etc.) y ejecuta tu navegador con **dos** flags importantes:
    *   `--remote-debugging-port=XXXX`: Donde `XXXX` es el valor de `DEBUGGING_PORT` en el script (por defecto 9222 o 9213 según la última versión que uses).
    *   `--proxy-server="URL_DEL_PROXY"`: **(MUY RECOMENDADO)** Especifica la URL de tu proxy residencial (ej. `http://usuario:contraseña@proxy.host:puerto`). **Este proxy es esencial para evitar bloqueos de IP.**

    **Ejemplos:**
    *   *Windows Chrome con Proxy:*
        ```bash
        "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --proxy-server="http://user:pass@proxy.example.com:8080"
        ```
    *   *macOS Chrome sin Proxy:*
        ```bash
        /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
        ```
    *   *Linux Edge con Proxy:*
        ```bash
        microsoft-edge --remote-debugging-port=9222 --proxy-server="http://user:pass@proxy.example.com:8080"
        ```
    Se abrirá una ventana normal del navegador.

3.  **Bypass Manual Vercel:** En la ventana del navegador que acabas de abrir:
    *   Navega a `https://claim.hyperlane.foundation/`.
    *   Si aparece el "Vercel Security Checkpoint" (el spinner), **espera a que se complete y la página principal cargue correctamente.** Es posible que necesites interactuar mínimamente (mover el ratón).
    *   **Deja esta pestaña abierta y activa.** El script se conectará a esta sesión.

4.  **Ejecutar el Script:** Abre **otra** terminal, navega al directorio del script y ejecuta:
    ```bash
    npm start
    ```
    o
    ```bash
    node monitor.js
    ```

5.  **Monitorear la Salida:** Observa los logs en la terminal donde ejecutaste el script. Busca:
    *   Mensajes de conexión exitosa al navegador.
    *   Resultados de las llamadas GET (`[DEBUG] GET ... Status 200` o `404`).
    *   Resultados de las llamadas POST (`[SUCCESS_REGISTER]` o errores `[ERROR_API_POST]`, `[BLOCK_POST]`, `[RATE_LIMIT_POST]`).
    *   Mensajes de anomalías detectadas y acciones de registro.
    *   Ajustes del factor de delay dinámico.

**¡IMPORTANTE!** Debes mantener abierta la ventana del navegador que lanzaste manualmente mientras el script esté en ejecución.

## Troubleshooting y Notas

*   **Error `[FATAL] Connect/Setup fail port XXXX`:** Asegúrate de haber lanzado el navegador con el flag `--remote-debugging-port=XXXX` **correcto** y que ninguna otra instancia esté usando ese puerto. Cierra todas las instancias del navegador y vuelve a intentarlo.
*   **Error `[BLOCK_GET?]` o `[BLOCK_POST]` (Status 403):**
    *   **¡Proxy Casi Obligatorio!** La causa más probable es que Vercel está bloqueando tu IP. Usa un **proxy residencial de buena calidad** al lanzar el navegador con `--proxy-server`.
    *   **Bypass Manual Incompleto:** Asegúrate de haber esperado a que el checkpoint de Vercel se complete *totalmente* en la pestaña del navegador antes de ejecutar el script. Intenta refrescar la página manualmente una vez más justo antes de ejecutar el script.
    *   **Detección Avanzada:** Si incluso con proxy y bypass manual sigues recibiendo 403, Vercel podría estar detectando la conexión CDP o patrones de comportamiento muy sutiles. Podría requerir soluciones más avanzadas.
*   **Error `[RATE_LIMIT_GET]` o `[RATE_LIMIT_POST]` (Status 429):** Estás haciendo demasiadas peticiones.
    *   Deja que el **delay dinámico** actúe. Observa si el `Factor` aumenta en los logs de pausa.
    *   Si persiste, **aumenta** los valores de `CHECK_INTERVAL` y `BASE_REQUEST_DELAY` en la configuración del script.
    *   Considera reducir el número total de wallets seguras que monitorizas si el problema es el volumen total.
*   **Error `[FATAL_LOAD]`:** Revisa que los archivos `secure.txt`, `elegibles.txt`, y `assignment.json` existan, tengan los permisos correctos y el formato JSON/texto esperado. Verifica que las claves privadas sean válidas. Asegúrate de que las direcciones en `assignment.json` tengan claves correspondientes en los otros archivos.
*   **Error LavaMoat:** Si vuelves a experimentar con `page.evaluate` y ves errores de LavaMoat, es probable que sea una interferencia de MetaMask u otra extensión similar. Usar `page.request` (como en la versión recomendada actual) debería evitarlo.

## Disclaimer

Este script interactúa con una API externa. Úsalo bajo tu propio riesgo y responsabilidad. Asegúrate de cumplir con los Términos de Servicio de Hyperlane y Vercel. Evita sobrecargar la API con peticiones excesivas. Los autores no se hacen responsables de ningún uso indebido, bloqueo de cuentas, pérdida de fondos o cualquier otro problema derivado del uso de este script.
