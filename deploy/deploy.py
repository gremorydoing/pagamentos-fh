"""
deploy.py — Script de deploy do Pagamentos FH
----------------------------------------------
Como usar:
1. Coloca o HTML novo baixado na mesma pasta que esse script (pasta deploy/)
2. Roda: python deploy.py
3. Pronto — commit + push feito, Netlify atualiza em 30s

Requisitos: Git instalado e repositório já autenticado pelo VSCode
"""

import os
import sys
import shutil
import subprocess
from pathlib import Path
from datetime import datetime

# ── Configuração ──────────────────────────────────────────────────────
# Pasta raiz do repositório (um nível acima de deploy/)
REPO_ROOT = Path(__file__).parent.parent
INDEX_FILE = REPO_ROOT / "index.html"
DEPLOY_DIR = Path(__file__).parent

def find_html():
    """Procura o HTML mais recente na pasta deploy/"""
    htmls = sorted(
        DEPLOY_DIR.glob("pagamentos-fh-v*.html"),
        key=lambda f: f.stat().st_mtime,
        reverse=True
    )
    if not htmls:
        # Tenta qualquer .html que não seja o index
        htmls = [f for f in DEPLOY_DIR.glob("*.html") if f.name != "index.html"]
    return htmls[0] if htmls else None

def run(cmd, cwd=None):
    """Roda um comando e retorna o output"""
    result = subprocess.run(
        cmd, shell=True, capture_output=True, text=True,
        cwd=cwd or REPO_ROOT
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()

def deploy():
    print("\n📦 Deploy — Pagamentos FH")
    print("─" * 40)

    # 1. Encontra o HTML
    html_file = find_html()
    if not html_file:
        print("❌ Nenhum arquivo HTML encontrado na pasta deploy/")
        print("   Coloca o arquivo pagamentos-fh-vXX.html aqui e tenta de novo.")
        input("\nAperta Enter para fechar...")
        sys.exit(1)

    version = html_file.stem  # ex: pagamentos-fh-v14
    print(f"✅ Arquivo encontrado: {html_file.name}")

    # 2. Copia para index.html na raiz do repo
    shutil.copy2(html_file, INDEX_FILE)
    print(f"✅ Copiado para: {INDEX_FILE}")

    # 3. Verifica se tem mudança real
    code, out, _ = run("git diff --stat HEAD index.html")
    if not out:
        print("ℹ️  Nenhuma mudança detectada — arquivo já está atualizado.")
        input("\nAperta Enter para fechar...")
        return

    # 4. Stage
    code, _, err = run("git add index.html")
    if code != 0:
        print(f"❌ Erro no git add: {err}")
        input("\nAperta Enter para fechar...")
        sys.exit(1)
    print("✅ Stage feito (git add)")

    # 5. Commit com mensagem automática
    now  = datetime.now().strftime("%d/%m/%Y %H:%M")
    msg  = f"{version} — deploy {now}"
    code, _, err = run(f'git commit -m "{msg}"')
    if code != 0:
        print(f"❌ Erro no commit: {err}")
        input("\nAperta Enter para fechar...")
        sys.exit(1)
    print(f"✅ Commit: {msg}")

    # 6. Push
    print("⏳ Enviando para o GitHub...")
    code, out, err = run("git push origin main")
    if code != 0:
        print(f"❌ Erro no push: {err}")
        print("   Dica: abre o VSCode e faz um 'Git: Pull' antes de tentar de novo.")
        input("\nAperta Enter para fechar...")
        sys.exit(1)

    print("✅ Push feito!")
    print("\n🚀 Netlify vai atualizar em ~30 segundos.")
    print(f"   Versão deployada: {version}")
    print("─" * 40)
    input("\nAperta Enter para fechar...")

if __name__ == "__main__":
    deploy()
