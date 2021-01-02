import { options } from 'preact';

/** @type {number} */
let currentIndex;

/** @type {import('./internal').Component} */
let currentComponent;
/**
 * Keep track of the previous component so that we can set
 * `currentComponent` to `null` and throw when a hook is invoked
 * outside of render
 * @type {import('./internal').Component}
 */
let previousComponent;

/** @type {number} */
let currentHook = 0;

/** @type {Array<import('./internal').Component>} */
let afterPaintEffects = [];

let oldBeforeDiff = options._diff;
let oldBeforeRender = options._render;
let oldAfterDiff = options.diffed;
let oldCommit = options._commit;
let oldBeforeUnmount = options.unmount;

const RAF_TIMEOUT = 100;
let prevRaf;

// diff 开始前，重置 hooks 上下文
options._diff = vnode => {
	currentComponent = null;

	if (oldBeforeDiff) {
		oldBeforeDiff(vnode);
	}
};

// render component 前调用，准备好环境变量，JavaScript 单线程确保不会出现竞争
options._render = vnode => {
	if (oldBeforeRender) {
		oldBeforeRender(vnode);
	}

	currentIndex = 0;
	currentComponent = vnode._component;

	const hooks = currentComponent.__hooks;

	// 组件内部含有 hook 使用，延迟初始化 hooks 数组
	if (hooks) {
		// 确认队列已清空，快速重渲染时才会重现，猜测 commit 阶段调用 setState 导致更新执行
		hooks._pendingEffects.forEach(invokeCleanup);
		hooks._pendingEffects.forEach(invokeEffect);
		hooks._pendingEffects = [];
	}
};

options.diffed = vnode => {
	if (oldAfterDiff) oldAfterDiff(vnode);

	const c = vnode._component;
	if (c && c.__hooks && c.__hooks._pendingEffects.length) {
		// afterPaint 内部启动队列消费仅触发一次，afterPaintEffects 首次插入实例时触发，暨 afterPaintEffects.push(c) === 1
		afterPaint(afterPaintEffects.push(c));
	}
	currentComponent = previousComponent;
};

options._commit = (vnode, commitQueue) => {
	commitQueue.some(component => {
		try {
			// renderCallbacks 入队内容，除了标准回调函数，还包括 useLayoutEffect hook state，属于非标操作
			// diff 完毕，先调用 cleanup 释放资源
			component._renderCallbacks.forEach(invokeCleanup);
			// 执行 effect, 并删除非标 renderCallback
			component._renderCallbacks = component._renderCallbacks.filter(cb =>
				cb._value ? invokeEffect(cb) : true
			);
		} catch (e) {
			commitQueue.some(c => {
				if (c._renderCallbacks) c._renderCallbacks = [];
			});
			commitQueue = [];
			options._catchError(e, component._vnode);
		}
	});

	if (oldCommit) oldCommit(vnode, commitQueue);
};

options.unmount = vnode => {
	if (oldBeforeUnmount) oldBeforeUnmount(vnode);

	const c = vnode._component;
	if (c && c.__hooks) {
		try {
			// 常规执行阶段，deps change 则 hook 入队处理
			// 卸载组件阶段，释放依赖资源，仅影响到 useEffect, useLayoutEffect
			c.__hooks._list.forEach(invokeCleanup);
		} catch (e) {
			options._catchError(e, c._vnode);
		}
	}
};

/**
 * Get a hook's state from the currentComponent
 * @param {number} index The index of the hook to get
 * @param {number} type The index of the hook to get
 * @returns {any}
 */
function getHookState(index, type) {
	if (options._hook) {
		options._hook(currentComponent, index, currentHook || type);
	}
	currentHook = 0;

	// Largely inspired by:
	// * https://github.com/michael-klein/funcy.js/blob/f6be73468e6ec46b0ff5aa3cc4c9baf72a29025a/src/hooks/core_hooks.mjs
	// * https://github.com/michael-klein/funcy.js/blob/650beaa58c43c33a74820a3c98b3c7079cf2e333/src/renderer.mjs
	// Other implementations to look at:
	// * https://codesandbox.io/s/mnox05qp8
	const hooks =
		currentComponent.__hooks ||
		(currentComponent.__hooks = {
			_list: [],
			// useEffect hook state
			_pendingEffects: []
		});

	if (index >= hooks._list.length) {
		hooks._list.push({});
	}
	return hooks._list[index];
}

/**
 * @param {import('./index').StateUpdater<any>} [initialState]
 */
export function useState(initialState) {
	currentHook = 1;

	// 使用 invokeOrReturn 确保返回 [state, setState] 支持
	// setState('new value') / setState((prev) => `new value`)
	return useReducer(invokeOrReturn, initialState);
}

/**
 * @param {import('./index').Reducer<any, any>} reducer
 * @param {import('./index').StateUpdater<any>} initialState
 * @param {(initialState: any) => void} [init]
 * @returns {[ any, (state: any) => void ]}
 */
export function useReducer(reducer, initialState, init) {
	// hook state 为标准空对象
	/** @type {import('./internal').ReducerHookState} */
	const hookState = getHookState(currentIndex++, 2);

	// 每次调用都更新 reducer，确保使用最新 reducer 计算
	hookState._reducer = reducer;

	// 首次调用，initial state / dispatch 仅会计算一次
	if (!hookState._component) {
		hookState._value = [
			// invokeOrReturn 用的莫名其妙，initialState 入参允许为函数？？
			!init ? invokeOrReturn(undefined, initialState) : init(initialState),

			action => {
				const nextValue = hookState._reducer(hookState._value[0], action);
				if (hookState._value[0] !== nextValue) {
					hookState._value = [nextValue, hookState._value[1]];
					hookState._component.setState({});
				}
			}
		];

		hookState._component = currentComponent;
	}

	return hookState._value; // [state, dispatch]
}

/**
 * @param {import('./internal').Effect} callback
 * @param {any[]} args
 */
export function useEffect(callback, args) {
	/** @type {import('./internal').EffectHookState} */
	const state = getHookState(currentIndex++, 3);

	// 猜测 _skipEffects 服务端渲染时使用，跳过执行，减少资源消耗
	if (!options._skipEffects) {
		// args 变化，hook state 插入队列
		if (argsChanged(state._args, args)) {
			state._value = callback;
			state._args = args;

			currentComponent.__hooks._pendingEffects.push(state);
		}
	}
}

/**
 * @param {import('./internal').Effect} callback
 * @param {any[]} args
 */
export function useLayoutEffect(callback, args) {
	/** @type {import('./internal').EffectHookState} */
	const state = getHookState(currentIndex++, 4);

	// state 包含 cleanup 函数，执行 effect 时声明
	if (!options._skipEffects) {
		if (argsChanged(state._args, args)) {
			state._value = callback;
			state._args = args;

			// _renderCallbacks 此处并非标准 renderCallback 函数
			currentComponent._renderCallbacks.push(state);
		}
	}
}

export function useRef(initialValue) {
	currentHook = 5;
	return useMemo(() => ({ current: initialValue }), []);
}

/**
 * @param {object} ref
 * @param {() => object} createHandle
 * @param {any[]} args
 */
export function useImperativeHandle(ref, createHandle, args) {
	currentHook = 6;
	useLayoutEffect(
		() => {
			if (typeof ref == 'function') ref(createHandle());
			else if (ref) ref.current = createHandle();
		},
		args == null ? args : args.concat(ref)
	);
}

/**
 * @param {() => any} factory
 * @param {any[]} args
 */
export function useMemo(factory, args) {
	/** @type {import('./internal').MemoHookState} */
	const state = getHookState(currentIndex++, 7);

	if (argsChanged(state._args, args)) {
		state._value = factory();
		state._args = args;
		state._factory = factory;
	}

	return state._value;
}

/**
 * @param {() => void} callback
 * @param {any[]} args
 */
export function useCallback(callback, args) {
	currentHook = 8;

	return useMemo(() => callback, args);
}

/**
 * @param {import('./internal').PreactContext} context
 */
export function useContext(context) {
	const provider = currentComponent.context[context._id];
	// We could skip this call here, but than we'd not call
	// `options._hook`. We need to do that in order to make
	// the devtools aware of this hook.
	/** @type {import('./internal').ContextHookState} */
	const state = getHookState(currentIndex++, 9);
	// The devtools needs access to the context object to
	// be able to pull of the default value when no provider
	// is present in the tree.
	state._context = context;

	if (!provider) return context._defaultValue;

	// 单次订阅 Context
	// This is probably not safe to convert to "!"
	if (state._value == null) {
		state._value = true;
		provider.sub(currentComponent);
	}

	return provider.props.value;
}

/**
 * Display a custom label for a custom hook for the devtools panel
 * @type {<T>(value: T, cb?: (value: T) => string | number) => void}
 */
export function useDebugValue(value, formatter) {
	if (options.useDebugValue) {
		options.useDebugValue(formatter ? formatter(value) : value);
	}
}

/**
 * @param {(error: any) => void} cb
 */
export function useErrorBoundary(cb) {
	/** @type {import('./internal').ErrorBoundaryHookState} */
	const state = getHookState(currentIndex++, 10);
	const errState = useState();

	state._value = cb;

	if (!currentComponent.componentDidCatch) {
		currentComponent.componentDidCatch = err => {
			if (state._value) state._value(err);
			errState[1](err);
		};
	}
	return [
		errState[0],
		() => {
			errState[1](undefined);
		}
	];
}

/**
 * After paint effects consumer.
 */
function flushAfterPaintEffects() {
	afterPaintEffects.forEach(component => {
		if (component._parentDom) {
			try {
				component.__hooks._pendingEffects.forEach(invokeCleanup);
				component.__hooks._pendingEffects.forEach(invokeEffect);
				component.__hooks._pendingEffects = [];
			} catch (e) {
				component.__hooks._pendingEffects = [];
				options._catchError(e, component._vnode);
			}
		}
	});
	afterPaintEffects = [];
}

let HAS_RAF = typeof requestAnimationFrame == 'function';

/**
 * Schedule a callback to be invoked after the browser has a chance to paint a new frame.
 * Do this by combining requestAnimationFrame (rAF) + setTimeout to invoke a callback after
 * the next browser frame.
 *
 * Also, schedule a timeout in parallel to the the rAF to ensure the callback is invoked
 * even if RAF doesn't fire (for example if the browser tab is not visible)
 *
 * @param {() => void} callback
 */
function afterNextFrame(callback) {
	const done = () => {
		clearTimeout(timeout);
		if (HAS_RAF) cancelAnimationFrame(raf);
		setTimeout(callback);
	};
	const timeout = setTimeout(done, RAF_TIMEOUT);

	let raf;
	if (HAS_RAF) {
		raf = requestAnimationFrame(done);
	}
}

// Note: if someone used options.debounceRendering = requestAnimationFrame,
// then effects will ALWAYS run on the NEXT frame instead of the current one, incurring a ~16ms delay.
// Perhaps this is not such a big deal.
/**
 * Schedule afterPaintEffects flush after the browser paints
 * @param {number} newQueueLength
 */
function afterPaint(newQueueLength) {
	if (newQueueLength === 1 || prevRaf !== options.requestAnimationFrame) {
		// 猜测仅为测试环境下使用
		prevRaf = options.requestAnimationFrame;

		(prevRaf || afterNextFrame)(flushAfterPaintEffects);
	}
}

/**
 * @param {import('./internal').EffectHookState} hook
 */
function invokeCleanup(hook) {
	// A hook cleanup can introduce a call to render which creates a new root, this will call options.vnode
	// and move the currentComponent away.
	const comp = currentComponent;
	if (typeof hook._cleanup == 'function') hook._cleanup();
	currentComponent = comp;
}

/**
 * Invoke a Hook's effect
 * @param {import('./internal').EffectHookState} hook
 */
function invokeEffect(hook) {
	// A hook call can introduce a call to render which creates a new root, this will call options.vnode
	// and move the currentComponent away.
	const comp = currentComponent;
	hook._cleanup = hook._value();
	currentComponent = comp;
}

/**
 * @param {any[]} oldArgs
 * @param {any[]} newArgs
 */
function argsChanged(oldArgs, newArgs) {
	return (
		!oldArgs ||
		oldArgs.length !== newArgs.length ||
		newArgs.some((arg, index) => arg !== oldArgs[index])
	);
}

function invokeOrReturn(arg, f) {
	return typeof f == 'function' ? f(arg) : f;
}
