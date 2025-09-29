import re

# i.html 파일에서 unitId 값을 추출하는 예제
# i.html 파일의 내용을 불러와 텍스트에 저장
text = open('i.html', 'r', encoding='utf-8').read()

pattern = r"\d\d:\d\d"

# 모든 일치 항목 찾기
matches = re.findall(pattern, text) 

print(matches)
# 출력: ['12345', '67890']