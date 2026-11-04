select_create_ordinary_pairs() {
  local selected=$1 writer_variant=$2 delivery_case=$3 delivery_pair=$4
  ordinary_pairs=(default runner)
  [[ -n $selected ]] || return 0
  if [[ -n $writer_variant || -n $delivery_case || -n $delivery_pair ]]; then
    return 1
  fi
  case "$selected" in
    default|runner) ordinary_pairs=("$selected") ;;
    *) return 1 ;;
  esac
}
