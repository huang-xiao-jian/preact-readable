# preact-readable

`preact` 源码修改版本，增加注释说明，调整内部实现。（注：基于 `v10.3.4` 代码说明，提交代码基于 `v10.5.7` 修改）

## 解读约定

部分关键词会多次出现，预先说明如下：

- `virtual dom` -  本质上只是 `javascript object tree` 。
- `virtual node` - `virtual dom` 中的每一个节点称之为 `virtual node`。
  - `element node` - 对应宿主环境直接支持的元素，如 `h4`、 `div` 等。
  - `component node` - 自定义组件，与宿主环境无关。
    - `class component`
    - `function component`
- `jsx` - 语法糖，使用类 `html` 风格创建 `virtual node`。

仅关注核心流程，源码进行裁剪，剔除部分如下：

-  `hydrate` 模式
-  `react` 废弃生命周期钩子
-  `replaceNode` 局部替换渲染相关

`virtual dom` 只是普通对象，需要映射机制将其实际渲染为 `DOM`，姑且称之为 **映射器**。每次数据变更，执行全量渲染的成本太高，性能影响较大，因而映射器的核心工作便是执行 **增量渲染**，通过比对新旧 `virtual dom tree`，寻找树的差异，然后将其应用到 `DOM tree`。前者称之为 `diff` 算法，后者称之为 `renderer` ，不同的 `virtual dom` 库内部实现不同，`preact` 内部实现并没有划分阶段，而是并行处理。

特别说明，`preact` 仅支持 `dom` 环境渲染，由于其本身代码量少，体量轻，修修改改支持其他宿主环境也不是问题。 `React` 能支持的宿主环境，理论上通过扩展 `preact` 依然可以支持。

## 工具函数说明

### `create-element`

`jsx` 转换函数，主要处理：

- `props normalize`  - `key`，`ref` 特殊处理
- `children normalize` - 多个子节点
- `default props padding`

为便于处理  `diff vnode`  流程，`VNode` 添加部分标记位：

- `_parent` - 直接父级 `vnode`
- `_dom` - `vnode` 对应 `DOM` 节点
- `_nextDom` - `component vnode` 领接 `dom` 节点
- `_component` -  `class component` 实例
- `_chilren` -  `flatten component vnode render` ，`element vnode` 为声明直接子 `vnode`
- `_depth` - `vnode` 深度，`diff` 过程中，逐层标记，用以 `commit` 阶段排序

便于整体功能完成，`Component Instance` 添加部分标记位：

- `_vnode` - 实例化触发节点
- `_nextState` - `state` 中间变量，用于缓冲 `setState` 操作
- `_children` - `render result`
- `_parentDom` -  上下文 `DOM` 节点
- `_renderCallbacks` - `sideeffects callback`
- `_globalContext` - 保留当前节点可访问 `context container`

`toChildArray`

`jsx` 的灵活性决定了声明 `children` 可以是多种数据类型并存，不利于比对处理， 需要进行标准化处理，排除 `null` 、`undefined`、`boolean` 类型，`Array` 类型需要扁平化处理。

```javascript
export function toChildArray(children, out = []) {
	if (children == null || typeof children == 'boolean') {
    // ignore
	} else if (Array.isArray(children)) {
		children.some(child => {
			toChildArray(child, out);
		});
	} else {
		out.push(children);
	}
	return out;
}
```

`applyRef`

```javascript
// ref extends ReturnType<createRef> 只需要简单赋值
// ref extends Function 需要调用容错，入参 VNode 限定范围
function applyRef(ref, value, vnode) {
  try {
    if (typeof ref == "function") {
      ref(value);
    } else {
      ref.current = value;
    }
  } catch (e) {
    options._catchError(e, vnode);
  }
}
```

### Component 说明

考虑 `class component` 内部实现，`setState` 触发 `reconciliation` 流程，单帧内可能多次调用，因而组件内部需要维持 `active state`， `pending state`。

`setState` 职责包括：

- `pending state` 初始化
- `pending state` 更新
- 实例进入更新队列，使用标记位 `_dirty`，防止重复入队

队列消费属于 `macro task`，仅需要单次触发。`component setState` 调用时，能够直接确认 `component` 关联的 `vnode` 发生变化，因而可以直接启动 `vnode diff` 流程，无需额外操作。

`diff` 参数：

- `parent dom` - 需要初次 `diff` 流程中进行标记，界面映射得以执行 `patch`
- `newVNode` - 实例关联节点本身
- `oldVNode` - 实例关联节点本身，浅拷贝，实际通过 `_children`  获取 `previous render result`
- `oldDom` - 如果包含渲染树，则为 `_dom` 指针，如果没有，需要确认后续最近的 `dom` 节点

`vnode._dom` 指向 `children` 内的 `head dom`，需要保持指针持续性正确指向。`element vnode` 不需要同步机制，`component vnode` 需要同步机制，且需要冒泡。

细分场景：

- `vnode._dom` 与 `old dom` 一致
- `vnode._dom` 与 `old dom` 不一致，`parent vnode` 为  `element vnode`
- `vnode._dom` 与 `old dom` 不一致，`parent vnode` 为 `component vnode`， `parent vnode _dom` 指向  `old dom`
- `vnode._dom` 与 `old dom` 不一致，`parent vnode` 为 `component vnode`， `parent vnode _dom` 不指向  `old dom`

简化图示：

![image-20201229102213816](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201229102213816.png)

```javascript
function updateParentDomPointers(vnode) {
  if ((vnode = vnode._parent) != null && vnode._component != null) {
    vnode._dom = null;

    for (let i = 0; i < vnode._children.length; i++) {
      const child = vnode._children[i];

      if (child != null && child._dom != null) {
        vnode._dom = child._dom;
        break;
      }
    }

    return updateParentDomPointers(vnode);
  }
}
```

处于性能考量，直接逐层更新 `_dom`，不判断是否需要更新。

## 流程解析

核心逻辑还是集中在 `diff` 算法，`React` 将这个过程称为 `Reconciliation，` `preact` 中称为 `Differantiate`。`preact` 实现仅包含三个文件：

- `index.js`
- `props.js`
- `children.js`

文件导出多个函数，按照难易程度进行说明。

### `diffProps`

```javascript
  // 此处裁减掉 hydrate，svg 相关内容
export function diffProps(dom, newProps, oldProps) {
	let i;

	for (i in oldProps) {
		if (i !== 'children' && i !== 'key' && !(i in newProps)) {
			setProperty(dom, i, null, oldProps[i]);
		}
	}

	for (i in newProps) {
		if (
			i !== 'children' &&
			i !== 'key' &&
			i !== 'value' &&
			i !== 'checked' &&
			oldProps[i] !== newProps[i]
		) {
			setProperty(dom, i, newProps[i], oldProps[i], isSvg);
		}
	}
}
```

`diffProps` 功能非常明确，比对新旧属性，并执行到 `dom` 节点。`key`、`children` 为逻辑属性，无实际对应，需要排除，`value`、`checked` 为何排除，后续 `diffChildren` 进行说明，操作委托 `setProperty` 函数执行。

```javascript
export function setProperty(dom, name, value, oldValue) {
  // normalize class property key
  if (isSvg) {
    if (name === "className") {
      name = "class";
    } else if (name === "class") {
      name += "Name";
    }
  }

  // style 支持 string, object literal 类型，需要特殊处理
  if (name === "style") {
    if (typeof value == "string") {
      dom.style.cssText = value;
    } else {
      // 新旧值类型不一致，重置之前字符串设置
      if (typeof oldValue == "string") {
        dom.style.cssText = oldValue = "";
      }

      // 删除逻辑
      if (oldValue) {
        for (name in oldValue) {
          if (!(value && name in value)) {
            setStyle(dom.style, name, "");
          }
        }
      }

      // 更新逻辑
      if (value) {
        for (name in value) {
          if (!oldValue || value[name] !== oldValue[name]) {
            setStyle(dom.style, name, value[name]);
          }
        }
      }
    }
  }
  // Benchmark for comparison: https://esbench.com/bench/574c954bdb965b9a00965ac6
  else if (name[0] === "o" && name[1] === "n") {
    const useCapture = name !== (name = name.replace(/Capture$/, ""));
    const nameLower = name.toLowerCase();

    if (nameLower in dom) {
      name = nameLower;
    }
    
    // when will event property key not in dom, while support addEventListener
    name = name.slice(2);

    if (!dom._listeners) {
      dom._listeners = {};
    }

    dom._listeners[name] = value;

    // 使用 eventProxy 避免频繁解绑、新绑事件，增加事件触发 hook
    if (value) {
      if (!oldValue) {
        dom.addEventListener(name, eventProxy, useCapture);
      }
    } else {
      dom.removeEventListener(name, eventProxy, useCapture);
    }
  }
  // 移步了解 dom properties, dom attributes 之间的差异与关联
  else if (
    name !== "list" &&
    name !== "tagName" &&
    // HTMLButtonElement.form and HTMLInputElement.form are read-only but can be set using
    // setAttribute
    name !== "form" &&
    name !== "type" &&
    name !== "size" &&
    name !== "download" &&
    name !== "href" &&
    name in dom
  ) {
    dom[name] = value == null ? "" : value;
  }
  // dom attributes 更新
  else if (typeof value != "function" && name !== "dangerouslySetInnerHTML") {
    if (
      value == null ||
      (value === false &&
        // ARIA-attributes have a different notion of boolean values.
        // The value `false` is different from the attribute not
        // existing on the DOM, so we can't remove it. For non-boolean
        // ARIA-attributes we could treat false as a removal, but the
        // amount of exceptions would cost us too many bytes. On top of
        // that other VDOM frameworks also always stringify `false`.
        !/^ar/.test(name))
    ) {
      dom.removeAttribute(name);
    } else {
      dom.setAttribute(name, value);
    }
  }
}
```

### `diffElementNodes`

比对新旧 `element vnode`，新建或更新 `dom` 节点，主要流程如下：

![img](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/16b31333c6559a09.png)

前文所述 `vnode._dom` 标记属性，此处用于判定 `dom` 节点是否已经创建，流程较为简单，特别说明 `dangerouslySetInnerHTML`：

| Before  | After   | Solution                        |
| ------- | ------- | ------------------------------- |
| `false` | `false` | `diff children`                 |
| `true`  | `false` | `reset and diff chilren`        |
| `false` | `true`  | `force override, skip children` |
| `true`  | `true`  | `force override, skip children` |

属性更新后，需要进一步考虑是否 `recursive diff children` 执行。

`element vnode` 指向的 `dom` 节点确定，后续不会出现变化，`component node` 指向 `dom` 节点不确定，可能会出现变化，但与此函数亦无关。 函数返回最终对应的 `dom` 节点，并不执行插入操作。

### `diff`

`diff` 用于比对新旧 `VNode` 节点，内部比较冗长，主要判断 `vnode` 类型，`component vnode` 内部处理，创建实例或更新实例，调用生命周期函数，`element vnode` 则直接调用 `diffElementNodes` 处理。

![diff 函数](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/diff%20%E5%87%BD%E6%95%B0.jpg)

此处不对 `diff` 函数进行完整说明，仅针对部分代码进行额外说明。

### 修正 `_dom` 

```JavaScript
newVNode._dom = diffElementNodes(
  oldVNode._dom,
  newVNode,
  oldVNode,
  ...rest
);
```

`diffElementNodes` --> `diffChldren` 调用链，`diffChldren` 会将 `newVNode._dom` 指向内部包含的第一个 `dom` 节点， 对于 `element vnode` 应该指向自身 `dom` 节点，实际上为修正。

### Context 

```javascript
let tmp = newType.contextType;
let provider = tmp && globalContext[tmp._id];
let componentContext = tmp
  ? provider
    ? provider.props.value
    : tmp._defaultValue
  : globalContext;

// Get component and set it to `c`
if (oldVNode._component) {
} else {
  // Instantiate the new component
  if ("prototype" in newType && newType.prototype.render) {
    newVNode._component = c = new newType(newProps, componentContext); // eslint-disable-line new-cap
  } else {
    newVNode._component = c = new Component(newProps, componentContext);
    c.constructor = newType;
    c.render = doRender;
  }
}
```

`Context` 用以跨层级通讯，`component` 额外声明 `contextType` 用以定位对应的 `provider`，`globalContext` 包含当前节点可访问 `provider` 集合。理论上来说，如果组件未声明 `contextType`，不应该传入 `context` 参数，此处为何传入 `globalContext` 作为入参？

`preact`通过将 `globalContext` 绑定在组件实例上，支持 `useContext hook` 特性：

```javascript
// 实例化后，重新赋值，避免开发者 constructor 内部搞事情
c.props = newProps;
c.context = componentContext;
c._globalContext = globalContext;
```

然而 `useContext` 内部实现依然是：

```javascript
function useContext(context) {
	const provider = currentComponent.context[context._id];
  /* .... */
	return provider.props.value;
}
```

猜测只是历史遗留问题，一般情况下，`class component` 声明 `contextType`，`function component` 直接使用 `useContext` ，不会出现任何问题。

假设基准代码如下：

```jsx
// context.js
import { createContext } from 'preact';

export const Theme = createContext('warm');
export const Unit = createContext('px')
export const Statistic = createContext(100);

// App.jsx
class App extends Component {
	render() {
		return (
			<Theme.Provider value="light">
				<Unit.Provider value="rpx">
					<Statistic.Provider value={200}>
						<Consumer />
					</Statistic.Provider>
				</Unit.Provider>
			</Theme.Provider>
		);
	}
}
```

反面教材 `1`：

```jsx
function Consumer(_, theme) {
	const unit = useContext(Unit);
	const statistic = useContext(Statistic);

	return <h3>{`theme --> ${theme}, unit --> ${unit}, statistic --> ${statistic}`}</h3>
}

Consumer.contextType = Theme;
```

渲染时，`theme` 为 `provider value`，`unit`、`statistic` 为默认值，实质上 `context` 失效。

反面教材 `2`：

```jsx
class Consumer extends Component {
	render() {
		const theme = useContext(Theme)
		const unit = useContext(Unit);
		const statistic = useContext(Statistic);

		return <h3>{`theme --> ${theme}, unit --> ${unit}, statistic --> ${statistic}`}</h3>
	}
}
```

渲染时，`theme`、`unit`、`statistic` 皆 为 `provider value`，实质上 `context` 照常生效。

#### Fragment

```javascript
let tmp = c.render(c.props, c.state, c.context);
let isTopLevelFragment = tmp != null && tmp.type == Fragment && tmp.key == null;
let renderResult = isTopLevelFragment ? tmp.props.children : tmp;
```

`Fragment` 亦为 `function component`，仅作为逻辑节点，没有构造函数，没有 `hooks` 调用，没有 `render` 自定义实现，因此可以直接跳过 `diff` 环节，直接进入 `diffChildren` 环节 ，此处不做处理，也完全不影响流程。

### `diff children`

`preact` 内部逻辑最为复杂的函数，性能向考虑，`diff children` 不能逐个匹配，而应该考虑 `type`、`key` 相同  `vnode` 进行比对，`index` 恰好匹配更佳。

特殊场景说明：

-  `new child vnode == null` ，直接跳过 `diff` 环节
-  `component vnode` / `element node` 完全不会匹配

匹配场景如下：

| 序号 | 新节点                                 | 旧节点                                 | new dom    |
| ---- | -------------------------------------- | -------------------------------------- | :--------- |
| 1    | `component node with null children`    | `null`                                 | `Null`     |
| 2    | `component node with null children`    | `component node with null children`    | `Null`     |
| 3    | `component node with null children`    | `component node with element children` | `Null`     |
| 4    | `component node with element children` | `null`                                 | `Not Null` |
| 5    | `component node with element children` | `component node with null children`    | `Not Null` |
| 6    | `component node with element children` | `component node with element children` | `Not Null` |
| 7    | `element node`                         | `null`                                 | `Not Null` |
| 8    | `element node`                         | `element node`                         | `Not Null` |

场景 `4`、`5`、`7` 上下文，新增节点，不影响 `oldDom` 指向。

场景 `6`、`8` 上下文特殊处理，由于 `oldDom` 单向迭代，`oldVNode` 全量搜索，因而导致 `oldVNode._dom`、`oldDom` 先后顺序并不固定。每个场景细分多个亚型，无非 `old dom` 恰好为 `old vnode dom` 、 `old dom`  在 `old vnode dom` 之前、 `old dom`  在 `old vnode dom` 之后。

#### 场景 `newDom == null` 详解

场景 `1`、`2` 上下文，不会对 `dom` 结构产生任何影响，不影响待匹配 `old dom` 变化。场景 `3` 上下文，需要处理 `oldDom` 偏移，特别说明，如果 `oldDom` 为空，意味着匹配尾部，无需重新计算。

```javascript
if (newDom != null) {
  /******/
} else if (
  oldDom &&
  oldVNode._dom == oldDom &&
  oldDom.parentNode != parentDom
) {
  // The above condition is to handle null placeholders. See test in placeholder.test.js:
  // `efficiently replace null placeholders in parent rerenders`
  oldDom = getDomSibling(oldVNode);
}

```

亚型 `3-A`：

![image-20201228171814669](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201228171814669.png)

满足条件  `oldVNode._dom == oldDom`，需要重新计算 `oldDom` 指针。`oldDom.parentNode != parentDom` 限制条件感觉多余，因为该场景下 `oldDom` 已经被卸载，也可能是为了处理 `hydrate`  模式下的适配。

亚型 `3-B`，无需计算偏移。

![image-20201228171939803](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201228171939803.png)

亚型 `3-C`，无需计算偏移。

![image-20201228172202588](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201228172202588.png)

### 场景 `newDom != null` 详解

`component vnode` 存在上下文嵌套，`element vnode` 不存在上下文嵌套，后者需要插入或移动 `dom` 节点，前者使用标记位 `_nextDom`，避免重复 `dom` 节点操作，也作为计算 `next oldDom` 依据，`component vnode` 皆符合判定。

```javascript
	if (childVNode._nextDom !== undefined) {
    /* ...... */
	} else if (
    oldVNode == null ||
		newDom != oldDom ||
		newDom.parentNode == null
	) {
		outer: if (oldDom == null || oldDom.parentNode !== parentDom) {
      /* ...... */
		} else {
      /* ...... */
		}
	}
```

`oldVNode == null` 意味着全新节点，`newDom.parentNode == null`  意味着新建  `dom` 节点，尚未插入，场景下都需要插入  `dom` 节点。

`newDom == oldDom` 无需处理，执行标准前移即可。

![image-20201228190948007](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201228190948007.png)

场景 `newDom != oldDom` 稍微复杂一些，若 `oldDom == null` 说明已经匹配到尾部，无论 `new dom` 新建或复用节点，直接调用 `parentDom.appendChild(newDom)` 执行即可，若为新建 `new dom` 节点，直接调用 `parentDom.insertBefore(newDom, oldDom)` 执行即可。

![image-20201228194105549](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201228194105549.png)

场景 `oldDom / newDom` 存在 `DOM tree` 内，需要进行优化。

`8-B` 场景，需要移动 `new dom` 节点。

![image-20201228191455299](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201228191455299.png)

`8-B` 极端场景：

![image-20201228200437797](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201228200437797.png)

`8-C` 场景，向下寻找 `newDom` ，匹配修改指针即可。

![image-20201228172202588](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201228172202588.png)

极端场景如下：

![image-20201228195842844](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201228195842844.png)

此处 `j++ < oldChildrenLength / 2` 为优化策略，`old dom` 单向递进，`8-C` 场景下，匹配节点偏移较小时，可以直接重定向指针，无需移动任何 `dom` 节点，匹配节点偏移过大时，如果直接移动指针，会导致可复用节点过少，因而使用移动节点的方式，尽可能复用现有节点。`8-B` 场景优化匹配过程，匹配半数节点执行移动操作，明显优于全量匹配后执行移动操作。

```javascript
// `j<oldChildrenLength; j+=2` is an alternative to `j++<oldChildrenLength/2`
for (
  sibDom = oldDom, j = 0;
  (sibDom = sibDom.nextSibling) && j < oldChildrenLength;
  j += 2
) {
  if (sibDom == newDom) {
    break outer;
  }
}
```

## 扩展能力

使用 `options` 作为关键帧回调，扩展 `hook` 包括：

- `event` - 浏览器事件
- `options.diff(vnode)`
- `options.render(vnode)`
- `options.diffed(vnode)`
- `options.commit(vnode, commitQueue)`
- `options.unmount(vnode)`
- `options.catchError(event, newVNode, oldVNode)`

`catchError` 出现场合包含：

-  `lifecycle hook` 执行
-  `render callback` 执行
-  `ref function` 执行

## 表现不一致

![image-20201228105802830](https://cdn.jsdelivr.net/gh/yangyuncai/upic-oss@master/uPic/image-20201228105802830-9124333.png)

