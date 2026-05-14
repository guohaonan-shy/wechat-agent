#!/bin/zsh
set -e

cd "$(dirname "$0")"
./install.sh

echo
echo "安装流程结束。按任意键退出。"
read -r -k 1
