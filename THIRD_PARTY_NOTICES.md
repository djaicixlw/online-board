# Уведомления о стороннем ПО (Third-Party Notices)

В проекте используются только зависимости со свободными пермиссивными лицензиями (`MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`) согласно разделу 3 `SPEC.md` и правилам `AGENTS.md`.

## Прямые зависимости проекта

### Корневой пакет (`package.json`)

| Пакет | Версия | Лицензия | Репозиторий / Источник | Назначение | 
| ----- | ----- | ----- | ----- | ----- | 
| [@eslint/js](https://www.npmjs.com/package/@eslint/js) | `^9.14.0` | MIT | [github.com/eslint/eslint](https://github.com/eslint/eslint) | Базовые правила ESLint для JavaScript | 
| [eslint](https://www.npmjs.com/package/eslint) | `^9.14.0` | MIT | [github.com/eslint/eslint](https://github.com/eslint/eslint) | Статический анализатор кода (линтер) | 
| [prettier](https://www.npmjs.com/package/prettier) | `^3.3.3` | MIT | [github.com/prettier/prettier](https://github.com/prettier/prettier) | Проверка и автоформатирование кода | 
| [typescript](https://www.npmjs.com/package/typescript) | `^5.6.3` | Apache-2.0 | [github.com/microsoft/TypeScript](https://github.com/microsoft/TypeScript) | Компилятор и проверка типов TypeScript (`strict`) | 
| [typescript-eslint](https://www.npmjs.com/package/typescript-eslint) | `^8.13.0` | MIT | [github.com/typescript-eslint/typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | Поддержка TypeScript для ESLint Flat Config | 
| [vitest](https://www.npmjs.com/package/vitest) | `^2.1.4` | MIT | [github.com/vitest-dev/vitest](https://github.com/vitest-dev/vitest) | Фреймворк модульного тестирования | 

### Фронтенд (`web/package.json`)

| Пакет | Версия | Лицензия | Репозиторий / Источник | Назначение | 
| ----- | ----- | ----- | ----- | ----- | 
| [@excalidraw/excalidraw](https://www.npmjs.com/package/@excalidraw/excalidraw) | `^0.18.0` | MIT | [github.com/excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) | Компонент интерактивного холста доски | 
| [react](https://www.npmjs.com/package/react) | `^18.3.1` | MIT | [github.com/facebook/react](https://github.com/facebook/react) | UI-библиотека (зависимость Excalidraw и интерфейса) | 
| [react-dom](https://www.npmjs.com/package/react-dom) | `^18.3.1` | MIT | [github.com/facebook/react](https://github.com/facebook/react) | Рендеринг React-компонентов в DOM | 
| [@types/react](https://www.npmjs.com/package/@types/react) | `^18.3.12` | MIT | [github.com/DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | Типы TypeScript для React | 
| [@types/react-dom](https://www.npmjs.com/package/@types/react-dom) | `^18.3.1` | MIT | [github.com/DefinitelyTyped/DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped) | Типы TypeScript для React DOM | 
| [@vitejs/plugin-react](https://www.npmjs.com/package/@vitejs/plugin-react) | `^4.3.3` | MIT | [github.com/vitejs/vite-plugin-react](https://github.com/vitejs/vite-plugin-react) | Плагин сборки React для Vite | 
| [vite](https://www.npmjs.com/package/vite) | `^5.4.10` | MIT | [github.com/vitejs/vite](https://github.com/vitejs/vite) | Сборщик и dev-сервер фронтенда | 

### Воркер (`worker/package.json`)

| Пакет | Версия | Лицензия | Репозиторий / Источник | Назначение | 
| ----- | ----- | ----- | ----- | ----- | 
| [@cloudflare/workers-types](https://www.npmjs.com/package/@cloudflare/workers-types) | `^4.20261031.0` | BSD-3-Clause / Apache-2.0 | [github.com/cloudflare/workerd](https://github.com/cloudflare/workerd) | Определения типов среды выполнения Cloudflare Workers | 
| [wrangler](https://www.npmjs.com/package/wrangler) | `^4.33.0` | MIT OR Apache-2.0 | [github.com/cloudflare/workers-sdk](https://github.com/cloudflare/workers-sdk) | CLI для локальной разработки и деплоя Cloudflare Workers | 

## Уведомление об авторских правах Excalidraw

Источник: <https://github.com/excalidraw/excalidraw/blob/master/LICENSE>

```
MIT License

Copyright (c) 2020 Excalidraw

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

```