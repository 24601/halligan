import { onBeforeUnmount, onMounted, ref } from 'vue';

/** Under 768px the hero stacks into a tabbed switcher. */
export function useNarrow(query = '(max-width: 767px)') {
  const narrow = ref(false);
  let media: MediaQueryList | undefined;
  const update = (): void => {
    narrow.value = Boolean(media?.matches);
  };
  onMounted(() => {
    media = window.matchMedia(query);
    update();
    media.addEventListener('change', update);
  });
  onBeforeUnmount(() => media?.removeEventListener('change', update));
  return narrow;
}
