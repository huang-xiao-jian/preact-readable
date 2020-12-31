import { EMPTY_OBJ, EMPTY_ARR } from '../constants';
import { Component } from '../component';
import { Fragment } from '../create-element';
import { diffChildren } from './children';
import { diffProps, setProperty } from './props';
import { assign, isElementNode, removeNode } from '../util';
import options from '../options';

/**
 * Diff two virtual nodes and apply proper changes to the DOM
 * @param {import('../internal').PreactElement} parentDom The parent of the DOM element
 * @param {import('../internal').VNode} newVNode The new virtual node
 * @param {import('../internal').VNode} oldVNode The old virtual node
 * @param {object} globalContext The current context object. Modified by getChildContext
 * @param {boolean} isSvg Whether or not this element is an SVG node
 * @param {Array<import('../internal').PreactElement>} excessDomChildren
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @param {import('../internal').PreactElement} oldDom The current attached DOM
 * element any new dom elements should be placed around. Likely `null` on first
 * render (except when hydrating). Can be a sibling DOM element when diffing
 * Fragments that have siblings. In most cases, it starts out as `oldChildren[0]._dom`.
 */
export function diff(
	parentDom,
	newVNode,
	oldVNode,
	globalContext,
	isSvg,
	excessDomChildren,
	commitQueue,
	oldDom
) {
	const newType = newVNode.type;

	// When passing through createElement it assigns the object
	// constructor as undefined. This to prevent JSON-injection.
	if (newVNode.constructor !== undefined) return null;

	if (options._diff) {
		options._diff(newVNode);
	}

	try {
		outer: if (typeof newType == 'function') {
			let c, isNew, oldProps, oldState, snapshot, clearProcessingException;
			let newProps = newVNode.props;

			// Necessary for createContext api. Setting this property will pass
			// the context value as `this.context` just for this component.
			const contextType = newType.contextType;
			const provider = contextType && globalContext[contextType._id];
			// Component.contextType 设计上必然有值
			// 不声明 contextType，保留 globalContext，hooks 引用，且作为 context 传入，可能埋雷
			const componentContext = provider
				? provider
					? provider.props.value
					: contextType._defaultValue
				: globalContext;

			/* component instantiate begin */
			// Get component and set it to `c`
			if (oldVNode._component) {
				c = newVNode._component = oldVNode._component;
				// TODO - find out flag meaning
				clearProcessingException = c._processingException = c._pendingError;
			} else {
				// Instantiate the new component
				if ('prototype' in newType && newType.prototype.render) {
					// @ts-ignore The check above verifies that newType is suppose to be constructed
					newVNode._component = c = new newType(newProps, componentContext); // eslint-disable-line new-cap
				} else {
					// @ts-ignore Trust me, Component implements the interface we want
					newVNode._component = c = new Component(newProps, componentContext);
					c.constructor = newType;
					c.render = doRender;
				}

				// subscribe only once for the first time
				if (provider) {
					provider.sub(c);
				}

				// ensure props correctly handled, in case of missing super() call
				if (c.props !== newProps) {
					c.props = newProps;
				}

				// ensure context correctly handled, in case of missing super() call
				if (c.context !== componentContext) {
					c.context = componentContext;
				}

				// normalize state just in case of no state initialize within constructor
				if (!c.state) {
					c.state = {};
				}

				// TODO - find out ma
				isNew = c._dirty = true;

				// preserve accessable context container
				// useContext 使用属性
				c._globalContext = globalContext;

				// side effects
				c._renderCallbacks = [];
			}

			/* component instantiate end */

			/* render() 调用前生命周期函数调用 */
			// Invoke getDerivedStateFromProps
			if (c._nextState == null) {
				c._nextState = c.state;
			}

			if (newType.getDerivedStateFromProps != null) {
				if (c._nextState == c.state) {
					c._nextState = assign({}, c._nextState);
				}

				assign(
					c._nextState,
					newType.getDerivedStateFromProps(newProps, c._nextState)
				);
			}

			oldProps = c.props;
			oldState = c.state;

			// Invoke pre-render lifecycle methods
			if (isNew) {
				// deprecate componentWillMount this line
				if (c.componentDidMount != null) {
					c._renderCallbacks.push(c.componentDidMount);
				}
			} else {
				// deprecate componentWillReceiveProps this line
				if (
					!c._force &&
					c.shouldComponentUpdate != null &&
					// prettier-ignore
					c.shouldComponentUpdate(newProps, c._nextState, componentContext) === false
					//  || newVNode._original === oldVNode._original
				) {
					// update props and buffer state without render
					c.props = newProps;
					c.state = c._nextState;
					// More info about this here: https://gist.github.com/JoviDeCroock/bec5f2ce93544d2e6070ef8e0036e4e8
					// if (newVNode._original !== oldVNode._original) c._dirty = false;
					// reuse existed
					c._vnode = newVNode;
					newVNode._dom = oldVNode._dom;
					newVNode._children = oldVNode._children;

					if (c._renderCallbacks.length) {
						commitQueue.push(c);
					}

					break outer;
				}

				// deprecate componentWillUpdate this line

				/* normal update procedure begin */
				if (c.componentDidUpdate != null) {
					c._renderCallbacks.push(() => {
						c.componentDidUpdate(oldProps, oldState, snapshot);
					});
				}
			}
			/* component pre-render lifecycle end */

			/* normal render procedure begin */
			c.props = newProps;
			c.state = c._nextState;
			c.context = componentContext;

			if (options._render) {
				options._render(newVNode);
			}

			c._dirty = false;
			c._vnode = newVNode;
			c._parentDom = parentDom;

			const renderResulRaw = c.render(c.props, c.state, c.context);

			// Handle setState called in render, see #2553
			c.state = c._nextState;

			// keep copied global context when encounter Provider
			if (c.getChildContext != null) {
				globalContext = assign(assign({}, globalContext), c.getChildContext());
			}

			if (!isNew && c.getSnapshotBeforeUpdate != null) {
				snapshot = c.getSnapshotBeforeUpdate(oldProps, oldState);
			}

			// optimize code, which delete safe
			// 确认是否跳过非必要 Fragment
			const isTopLevelFragment =
				renderResulRaw != null &&
				renderResulRaw.type === Fragment &&
				renderResulRaw.key == null;
			const renderResult = isTopLevelFragment
				? renderResulRaw.props.children
				: renderResulRaw;

			diffChildren(
				parentDom,
				Array.isArray(renderResult) ? renderResult : [renderResult],
				newVNode,
				oldVNode,
				globalContext,
				isSvg,
				excessDomChildren,
				commitQueue,
				oldDom
			);

			// c.base 目测没有用到
			c.base = newVNode._dom;

			if (c._renderCallbacks.length) {
				commitQueue.push(c);
			}

			// if (clearProcessingException) {
			// 	c._pendingError = c._processingException = null;
			// }

			c._force = false;
		}
		// ignore _original for the moment
		//  else if (
		// 	excessDomChildren == null &&
		// 	newVNode._original === oldVNode._original
		// ) {
		// 	newVNode._children = oldVNode._children;
		// 	newVNode._dom = oldVNode._dom;
		// }
		else {
			newVNode._dom = diffElementNodes(
				oldVNode._dom,
				newVNode,
				oldVNode,
				globalContext,
				isSvg,
				excessDomChildren,
				commitQueue
			);
		}

		if (options.diffed) {
			options.diffed(newVNode);
		}
	} catch (e) {
		// newVNode._original = null;
		// if hydrating or creating initial tree, bailout preserves DOM:
		// if (excessDomChildren != null) {
		// 	newVNode._dom = oldDom;
		// 	newVNode._hydrating = !!isHydrating;
		// 	excessDomChildren[excessDomChildren.indexOf(oldDom)] = null;
		// ^ could possibly be simplified to:
		// excessDomChildren.length = 0;
		// }
		options._catchError(e, newVNode, oldVNode);
	}
}

/**
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @param {import('../internal').VNode} root
 */
export function commitRoot(commitQueue, root) {
	if (options._commit) {
		options._commit(root, commitQueue);
	}

	commitQueue.some(c => {
		try {
			// @ts-ignore Reuse the commitQueue variable here so the type changes
			commitQueue = c._renderCallbacks;
			c._renderCallbacks = [];
			commitQueue.some(cb => {
				// @ts-ignore See above ts-ignore on commitQueue
				cb.call(c);
			});
		} catch (e) {
			options._catchError(e, c._vnode);
		}
	});
}

/**
 * Diff two virtual nodes representing DOM element
 * @param {import('../internal').PreactElement} dom The DOM element representing
 * the virtual nodes being diffed
 * @param {import('../internal').VNode} newVNode The new virtual node
 * @param {import('../internal').VNode} oldVNode The old virtual node
 * @param {object} globalContext The current context object
 * @param {boolean} isSvg Whether or not this DOM node is an SVG node
 * @param {*} excessDomChildren
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @returns {import('../internal').PreactElement}
 */
function diffElementNodes(
	dom,
	newVNode,
	oldVNode,
	globalContext,
	isSvg,
	excessDomChildren,
	commitQueue
) {
	let i;
	let oldProps = oldVNode.props;
	let newProps = newVNode.props;

	// Tracks entering and exiting SVG namespace when descending through the tree.
	isSvg = newVNode.type === 'svg' || isSvg;

	if (excessDomChildren != null) {
		for (i = 0; i < excessDomChildren.length; i++) {
			const child = excessDomChildren[i];

			// if newVNode matches an element in excessDomChildren or the `dom`
			// argument matches an element in excessDomChildren, remove it from
			// excessDomChildren so it isn't later removed in diffChildren
			if (
				child != null &&
				((newVNode.type === null
					? child.nodeType === 3
					: child.localName === newVNode.type) ||
					dom == child)
			) {
				dom = child;
				excessDomChildren[i] = null;
				break;
			}
		}
	}

	// 创建 DOM 逻辑
	if (dom == null) {
		if (newVNode.type === null) {
			// @ts-ignore createTextNode returns Text, we expect PreactElement
			return document.createTextNode(newProps);
		}

		if (isSvg) {
			dom = document.createElementNS(
				'http://www.w3.org/2000/svg',
				// @ts-ignore We know `newVNode.type` is a string
				newVNode.type
			);
		} else {
			dom = document.createElement(
				// @ts-ignore We know `newVNode.type` is a string
				newVNode.type,
				newProps.is && { is: newProps.is }
			);
		}

		// we created a new parent, so none of the previously attached children can be reused:
		excessDomChildren = null;
	}

	// 更新 DOM 逻辑
	if (newVNode.type === null) {
		if (oldProps !== newProps) {
			dom.data = newProps;
		}
	} else {
		if (excessDomChildren != null) {
			excessDomChildren = EMPTY_ARR.slice.call(dom.childNodes);
		}

		oldProps = oldVNode.props || EMPTY_OBJ;

		const oldHtml = oldProps.dangerouslySetInnerHTML;
		const newHtml = newProps.dangerouslySetInnerHTML;

		// But, if we are in a situation where we are using existing DOM (e.g. replaceNode)
		// we should read the existing DOM attributes to diff them
		if (excessDomChildren != null) {
			oldProps = {};
			for (let i = 0; i < dom.attributes.length; i++) {
				oldProps[dom.attributes[i].name] = dom.attributes[i].value;
			}
		}

		if (newHtml || oldHtml) {
			// Avoid re-applying the same '__html' if it did not changed between re-render
			// while oldHtml not null
			if (!newHtml) {
				dom.innerHTML = '';
			}
			// while newHtml not null
			if (newHtml.__html != oldHtml?.__html) {
				// fallback into real equality check
				if (newHtml.__html !== dom.innerHTML) {
					dom.innerHTML = newHtml.__html;
				}
			}
		}

		diffProps(dom, newProps, oldProps, isSvg);

		// If the new vnode didn't have dangerouslySetInnerHTML, diff its children
		if (newHtml) {
			newVNode._children = [];
		} else {
			const children = newVNode.props.children;

			diffChildren(
				dom,
				Array.isArray(children) ? children : [children],
				newVNode,
				oldVNode,
				globalContext,
				newVNode.type === 'foreignObject' ? false : isSvg,
				excessDomChildren,
				commitQueue,
				EMPTY_OBJ
			);
		}

		if (
			'value' in newProps &&
			newProps.value !== undefined &&
			// #2756 For the <progress>-element the initial value is 0,
			// despite the attribute not being present. When the attribute
			// is missing the progress bar is treated as indeterminate.
			// To fix that we'll always update it when it is 0 for progress elements
			(newProps.value !== dom.value || (newVNode.type === 'progress' && !i))
		) {
			setProperty(dom, 'value', newProps.value, oldProps.value, false);
		}
		if (
			'checked' in newProps &&
			newProps.checked !== undefined &&
			newProps.checked !== dom.checked
		) {
			setProperty(dom, 'checked', newProps.checked, oldProps.checked, false);
		}
	}

	return dom;
}

/**
 * Invoke or update a ref, depending on whether it is a function or object ref.
 * @param {object|function} ref
 * @param {any} value
 * @param {import('../internal').VNode} vnode
 */
export function applyRef(ref, value, vnode) {
	try {
		// deprecated function ref
		if (typeof ref == 'function') {
			ref(value);
		} else {
			ref.current = value;
		}
	} catch (e) {
		options._catchError(e, vnode);
	}
}

/**
 * Unmount a virtual node from the tree and apply DOM changes
 * @param {import('../internal').VNode} vnode The virtual node to unmount
 * @param {import('../internal').VNode} parentVNode The parent of the VNode that
 * initiated the unmount
 * @param {boolean} [skipRemove] Flag that indicates that a parent node of the
 * current element is already detached from the DOM.
 */
export function unmount(vnode, parentVNode, skipRemove) {
	if (options.unmount) {
		options.unmount(vnode);
	}

	const ref = vnode.ref;

	if (ref) {
		// `ref` is function or `ref` point component instance
		if (!ref.current || ref.current === vnode._dom) {
			applyRef(ref, null, parentVNode);
		}
	}

	const dom = vnode._dom;
	// skipRemove 自上向下传递，DOM tree 父节点删除，下层则无需调用
	// DOM tree 节点删除操作 Element Node 处执行
	const skipRemoveNext = skipRemove || isElementNode(vnode);

	// if (!skipRemove) {
	// 	if (typeof vnode.type != 'function') {
	// 		dom = vnode._dom;
	// 		skipRemove = dom != null;
	// 	}
	// }

	// Must be set to `undefined` to properly clean up `_nextDom`
	// for which `null` is a valid value. See comment in `create-element.js`
	vnode._nextDom = undefined;
	vnode._dom = undefined;

	const c = vnode._component;

	if (c != null) {
		if (c.componentWillUnmount) {
			try {
				c.componentWillUnmount();
			} catch (e) {
				options._catchError(e, parentVNode);
			}
		}

		c.base = c._parentDom = null;
	}

	const children = vnode._children;

	if (children) {
		for (let i = 0; i < children.length; i++) {
			if (children[i]) {
				unmount(children[i], parentVNode, skipRemoveNext);
			}
		}
	}

	if (!skipRemove) {
		if (dom != null) {
			removeNode(dom);
		}
	}
}

/** The `.render()` method for a PFC backing instance. */
function doRender(props, state, context) {
	return this.constructor(props, context);
}
