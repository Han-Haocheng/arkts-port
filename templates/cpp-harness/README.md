# C/C++ golden harness 模板

**状态：未验证模板**

```cpp
// harness.cpp
#include <cstdio>
#include <string>
#include "target.h"

int main() {
    const char* inputs[] = {"abc", "一二三"};
    printf("[");
    for (int i = 0; i < 2; i++) {
        std::string r = target_process(inputs[i]);
        printf("%s{\"scenario\":\"s%d\",\"result\":\"%s\"}", i ? "," : "", i, r.c_str());
    }
    printf("]\n");
    return 0;
}
```

运行：`clang++ -std=c++17 harness.cpp target.cpp -o harness && ./harness > golden.json`

注意：只建议纯算法库；有源码时优先用 OHOS NDK 重编成 `.so`，不要转写。
