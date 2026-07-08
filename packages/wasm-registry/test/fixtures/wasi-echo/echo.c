#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  fprintf(stdout, "argc=%d\n", argc);
  for (int i = 1; i < argc; i++) {
    fprintf(stdout, "arg[%d]=%s\n", i, argv[i]);
  }

  FILE *in = fopen("/work/input.txt", "r");
  if (in) {
    char buf[256];
    size_t n = fread(buf, 1, sizeof(buf) - 1, in);
    buf[n] = '\0';
    fclose(in);
    fprintf(stdout, "read:%s\n", buf);

    FILE *out = fopen("/work/output.txt", "w");
    if (out) {
      fprintf(out, "processed:%s", buf);
      fclose(out);
    }
  } else {
    fprintf(stderr, "could not open input\n");
    return 2;
  }

  return 0;
}
