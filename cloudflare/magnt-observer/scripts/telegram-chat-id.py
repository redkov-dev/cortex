#!/usr/bin/env python3
"""One-time, read-only setup using Telegram's API. Never stores or prints a bot token."""
import getpass
import json
import re
import secrets
import sys
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(token, method, params=None):
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(params or {}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Telegram HTTP {error.code}") from None
    except (urllib.error.URLError, TimeoutError, ValueError):
        raise RuntimeError("Не удалось прочитать ответ Telegram") from None
    if data.get("ok") is not True:
        raise RuntimeError("Telegram не подтвердил запрос")
    return data["result"]


def main():
    if not sys.stdin.isatty():
        raise RuntimeError("Запусти скрипт в обычном терминале: токен вводится скрыто")
    token = getpass.getpass("Токен бота из BotFather (скрытый ввод): ").strip()
    if not re.fullmatch(r"\d+:[A-Za-z0-9_-]{20,}", token):
        raise RuntimeError("Неверный формат токена")
    bot = api(token, "getMe")
    username = bot.get("username", "")
    if not re.fullmatch(r"[A-Za-z0-9_]{1,64}", username):
        raise RuntimeError("Не удалось определить имя бота")
    marker = "/magnt_setup_" + secrets.token_hex(8)
    print(f"Открой личный чат @{username} в своём Telegram и отправь:\n{marker}")
    input("После отправки нажми Enter здесь: ")
    updates = api(token, "getUpdates", {"limit": 100, "timeout": 0, "allowed_updates": ["message"]})
    ids = set()
    for update in updates:
        message = update.get("message", {})
        chat, sender = message.get("chat", {}), message.get("from", {})
        chat_id = chat.get("id")
        if (message.get("text") == marker and chat.get("type") == "private"
                and isinstance(chat_id, int) and chat_id > 0
                and sender.get("id") == chat_id and sender.get("is_bot") is False):
            ids.add(chat_id)
    if len(ids) != 1:
        raise RuntimeError("Контрольное сообщение не найдено однозначно. Повтори настройку с новым ботом без webhook")
    print(f"TELEGRAM_OWNER_CHAT_ID = {ids.pop()}")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyboardInterrupt, EOFError) as error:
        print(str(error) or "Настройка остановлена", file=sys.stderr)
        sys.exit(1)
