---
name: pbs-products
description: 根据场景需求检索公司产品能力与限制，组合项目解决方案并生成有依据的 PBS 和 BOM 草稿。
---

先读取原始需求、场景及未解决问题。search_evidence(domain=products) 查找候选，read_product 获取完整能力、限制与 BOM；不要仅凭名称匹配产品。

每次优先核对最相关的少量候选。已有能力和约束足以判断时停止扩展检索，不逐个通读整个产品目录；存在具体缺口时再定向查询。

产品来源为自有产品、外采、自研、服务。已有产品可复用、组合或需要集成；能力/约束不满足时明确缺口，不能修改目录内容或捏造已有能力。项目解决方案按客户目标自由组合，不进入共享产品库。

blocked_by 只用于另行交付的外采/自研缺口，指向无法满足该要求的产品，不能与本行 product_ref 相同。已有产品的使用条件写入 spec/basis，不能因此清除产品关联。客户提供的服务器或设备作为环境依赖，不自行新增外采采购项；需要时列部署适配服务。

submit_pbs 的 items 含 name、parent、source、product_ref、req_ids、scenario_ids、matched_capabilities、spec、basis、qty、unit、sizing_rule、evidence_chunks。parent 从 project_state 的分组选择；产品匹配必须引用真实 product_ref。未知数量用 null，不用 1 掩盖未知；数量规则和许可/BOM 关系由工具校验。

submit_pbs 可分批合并提交，每批不超过80项。只修改本批同名的未人工处理草稿，其他已存项保留；修改草稿保持名称以保留其ID。过期或重复项通过 propose_change 提出删除建议，不靠省略旧项隐式删除。每批使用最新 pbs_version。

每项关联真实需求，说明能力对应关系和限制。服务、集成与实施不能隐去，商务资质不变成产品项。先提交可审阅草稿，再读取 run_report，修复未覆盖、约束冲突与来源问题；有待确认项可交付草稿，但不能宣布项目已完成。

需要项目解决方案时，在PBS保存后重新读取project_state取得真实item ID和新版pbs_version，再用submit_solutions将产品项组合到客户目标下。不要将BOM组件重复当作采购产品计量。
