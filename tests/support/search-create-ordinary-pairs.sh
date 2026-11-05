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
select_writer_mapping_prepare_pair() {
  local mapping_case=$1 mapping_pair=$2 ordinary=$3 writer=$4 delivery=$5 delivery_pair=$6
  [[ $mapping_case =~ ^(positive|measured)$ &&
     $mapping_pair =~ ^(default|runner)$ &&
     -z $ordinary && -z $writer && -z $delivery && -z $delivery_pair ]] || return 1
  mapping_pairs=("$mapping_pair")
}
select_writer_mapping_delivery_pair() {
  local case_name=$1 selected_pair=$2 ordinary=$3 writer=$4 delivery=$5 delivery_pair=$6 \
    mapping_case=$7 mapping_pair=$8
  [[ $case_name =~ ^(positive|prestart|lost-return|false-ack|held-timeout)$ &&
     $selected_pair =~ ^(default|runner)$ && -z $ordinary && -z $writer &&
     -z $delivery && -z $delivery_pair && -z $mapping_case && -z $mapping_pair ]] || return 1
  mapping_delivery_pairs=("$selected_pair")
}
