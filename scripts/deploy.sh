#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
# Bot Restaurante — Script de Deploy Inicial em VPS
#
# Testado em: Ubuntu 22.04 / 24.04 (DigitalOcean, Hostinger, Vultr, etc.)
#
# Uso:
#   chmod +x scripts/deploy.sh
#   sudo ./scripts/deploy.sh
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Cores para output ─────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()     { echo -e "${GREEN}[✓]${NC} $1"; }
warn()    { echo -e "${YELLOW}[!]${NC} $1"; }
error()   { echo -e "${RED}[✗]${NC} $1"; exit 1; }
section() { echo -e "\n${BLUE}══ $1 ══${NC}"; }

# ── Configurações ─────────────────────────────────────────────────────────────
REPO_URL="${REPO_URL:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/bot-restaurante}"
NODE_VERSION="20"

# ── Pré-verificações ──────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  error "Execute como root: sudo ./scripts/deploy.sh"
fi

if [ -z "$REPO_URL" ]; then
  warn "REPO_URL não definida. Defina antes de rodar:"
  warn "  export REPO_URL=https://github.com/seu-usuario/bot-restaurante"
  warn "  sudo -E ./scripts/deploy.sh"
  echo ""
  warn "Ou continuando sem clonar (pasta atual já é o projeto)..."
  SKIP_CLONE=true
else
  SKIP_CLONE=false
fi

# ── 1. Atualiza pacotes do sistema ────────────────────────────────────────────
section "Atualizando sistema"
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq curl git wget ufw
log "Sistema atualizado"

# ── 2. Instala Docker ─────────────────────────────────────────────────────────
section "Instalando Docker"

if command -v docker &>/dev/null; then
  log "Docker já instalado: $(docker --version)"
else
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  log "Docker instalado: $(docker --version)"
fi

# ── 3. Instala Docker Compose Plugin ─────────────────────────────────────────
section "Verificando Docker Compose"

if docker compose version &>/dev/null; then
  log "Docker Compose já disponível: $(docker compose version)"
else
  apt-get install -y -qq docker-compose-plugin
  log "Docker Compose instalado: $(docker compose version)"
fi

# ── 4. Instala Node.js (para Strapi fora do Docker) ──────────────────────────
section "Instalando Node.js ${NODE_VERSION}"

if command -v node &>/dev/null && [[ "$(node -v)" == v${NODE_VERSION}* ]]; then
  log "Node.js já instalado: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
  log "Node.js instalado: $(node -v)"
fi

# ── 5. Clona o repositório ────────────────────────────────────────────────────
section "Preparando código"

if [ "$SKIP_CLONE" = false ]; then
  if [ -d "$INSTALL_DIR" ]; then
    warn "Diretório $INSTALL_DIR já existe. Puxando atualizações..."
    cd "$INSTALL_DIR"
    git pull
  else
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi
  log "Repositório em $INSTALL_DIR"
else
  INSTALL_DIR="$(pwd)"
  log "Usando diretório atual: $INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ── 6. Copia e configura .env ─────────────────────────────────────────────────
section "Configurando variáveis de ambiente"

if [ ! -f ".env" ]; then
  if [ -f ".env.production.example" ]; then
    cp .env.production.example .env
    warn "Arquivo .env criado a partir do exemplo."
    warn "⚠️  EDITE o .env agora antes de continuar!"
    warn "   nano $INSTALL_DIR/.env"
    echo ""
    read -p "Pressione ENTER após editar o .env para continuar..." -r
  else
    error "Arquivo .env.production.example não encontrado!"
  fi
else
  log ".env já existe — usando configuração atual"
fi

# Valida variáveis obrigatórias
source .env 2>/dev/null || true
REQUIRED_VARS="DB_PASSWORD ANTHROPIC_API_KEY EVOLUTION_API_KEY ADMIN_TOKEN BOT_PUBLIC_URL"
for var in $REQUIRED_VARS; do
  val="${!var:-}"
  if [ -z "$val" ] || [[ "$val" == *"TROQUE"* ]]; then
    error "Variável $var não configurada no .env!"
  fi
done
log "Variáveis de ambiente validadas"

# ── 7. Sobe os containers Docker ──────────────────────────────────────────────
section "Subindo containers Docker"

docker compose pull --quiet
docker compose up -d --build

log "Containers iniciados"

# ── 8. Aguarda o bot ficar saudável ──────────────────────────────────────────
section "Aguardando bot ficar pronto"

MAX_WAIT=60
WAITED=0
while [ $WAITED -lt $MAX_WAIT ]; do
  STATUS=$(docker compose ps --format json bot 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('Health',''))" 2>/dev/null || echo "")
  if [ "$STATUS" = "healthy" ]; then
    log "Bot está saudável!"
    break
  fi
  echo -n "."
  sleep 3
  WAITED=$((WAITED + 3))
done

if [ $WAITED -ge $MAX_WAIT ]; then
  warn "Timeout aguardando healthcheck — verifique os logs: docker compose logs bot"
fi

# ── 9. Configura o Strapi (fora do Docker) ────────────────────────────────────
section "Configurando Strapi CMS"

if [ -d "$INSTALL_DIR/strapi" ]; then
  cd "$INSTALL_DIR/strapi"

  if [ ! -f ".env" ]; then
    cp .env.example .env 2>/dev/null || true
    warn "Configure o strapi/.env antes de iniciar o Strapi"
  fi

  npm install --omit=dev --silent
  log "Dependências do Strapi instaladas"

  # Cria serviço systemd para o Strapi
  cat > /etc/systemd/system/strapi.service <<EOF
[Unit]
Description=Bot Restaurante — Strapi CMS
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR/strapi
ExecStart=/usr/bin/node_modules/.bin/strapi start
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable strapi
  warn "Strapi configurado como serviço. Inicie com: systemctl start strapi"
  warn "Configure strapi/.env primeiro e execute: cd $INSTALL_DIR/strapi && npm run build"
fi

cd "$INSTALL_DIR"

# ── 10. Configura firewall ────────────────────────────────────────────────────
section "Configurando firewall (UFW)"

ufw --force reset > /dev/null 2>&1
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
log "Firewall configurado (SSH + 80 + 443)"

# ── 11. Exibe URLs de acesso ──────────────────────────────────────────────────
section "Deploy concluído!"

source .env 2>/dev/null || true
PUBLIC="${BOT_PUBLIC_URL:-http://$(curl -s ifconfig.me)}"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Bot Restaurante — URLs de Acesso               ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC} Healthcheck   : ${PUBLIC}/health"
echo -e "${GREEN}║${NC} Strapi Admin  : ${PUBLIC}/admin"
echo -e "${GREEN}║${NC} Evolution API : ${PUBLIC}/evolution"
echo -e "${GREEN}║${NC} API Bot       : ${PUBLIC}/api/"
echo -e "${GREEN}╠══════════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC} Logs do bot   : docker compose logs -f bot"
echo -e "${GREEN}║${NC} Status        : docker compose ps"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Próximos passos:${NC}"
echo "  1. Configure o Strapi: cd $INSTALL_DIR/strapi && nano .env && npm run build"
echo "  2. Inicie o Strapi: systemctl start strapi"
echo "  3. Acesse ${PUBLIC}/admin para criar o admin do Strapi"
echo "  4. Gere o API Token no Strapi e atualize STRAPI_TOKEN no .env"
echo "  5. Para SSL: certbot --nginx -d seudominio.com"
echo ""
